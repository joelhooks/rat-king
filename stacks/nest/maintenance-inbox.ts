import {
  Clock,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Result,
  Schema,
} from "effect";

import { EncryptedEnvelope } from "../../packages/lexicon/src/defs.ts";
import { AgentName } from "../../packages/ratking-client/src/name.ts";
import {
  DEFAULT_GRACE_MINUTES,
  MAILBOX_INSTANCE,
  MaintenanceFile,
  WINDOW_MEMORY_MS,
  endWindow,
  readMaintenanceDocument,
  startWindow,
  windowOpen,
  writeMaintenanceText,
} from "./alarm-maintenance.ts";
import type { MaintenanceWindowValue } from "./alarm-maintenance.ts";
import { FleetError } from "./stage-config.ts";
import type { JsonDocument } from "./stage-config.ts";

const Id = Schema.String.check(
  Schema.isPattern(/^\d{20}-[0-9a-f]{32}$/u),
  Schema.isMinLength(53),
  Schema.isMaxLength(53)
);

const Iso = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u)
);

const MaintenanceDrop = Schema.Struct({
  action: Schema.Literals(["start", "end"]),
  id: Id,
  instance: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[^\p{Cc}]+$/u)
  ),
  owner: AgentName,
  reason: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
    Schema.isPattern(/\S/u)
  ),
  until: Iso,
});

export const MaintenanceNoticeReceipt = Schema.Struct({
  envelope: EncryptedEnvelope,
  recipient: AgentName,
});

const Notice = Schema.TaggedUnion({
  Dropped: { decidedAt: Schema.Int },
  Prepared: {
    at: Schema.Int,
    decidedAt: Schema.Int,
    receipt: MaintenanceNoticeReceipt,
  },
  Queued: {
    at: Schema.Int,
    decidedAt: Schema.Int,
    fallback: Schema.Boolean,
    text: Schema.NonEmptyString,
  },
  Sent: { decidedAt: Schema.Int },
});

const State = Schema.Struct({
  ...MaintenanceFile.fields,
  requests: Schema.optionalKey(Schema.Record(Schema.String, Notice)),
});

type NoticeValue = typeof Notice.Type;

type Drop = typeof MaintenanceDrop.Type;

export class MaintenancePreparationRefused extends Data.TaggedError(
  "MaintenancePreparationRefused"
) {}

interface Inbox {
  readonly desk: string;
  readonly directory: string;
  readonly inbox: { readonly path: string; readonly operatorUid: number };
  readonly instances: readonly string[];
}

export interface MaintenanceNoticePorts<PrepareError, SendError, R> {
  readonly prepare: (
    text: string
  ) => Effect.Effect<
    typeof MaintenanceNoticeReceipt.Type,
    PrepareError | MaintenancePreparationRefused,
    R
  >;
  readonly send: (
    receipt: typeof MaintenanceNoticeReceipt.Type
  ) => Effect.Effect<void, SendError, R>;
  readonly unavailable: Effect.Effect<void, never, R>;
}

const maxBytes = 4096;

const maxAge = 4 * 3_600_000;

const decodeDrop = Schema.decodeOption(Schema.fromJsonString(MaintenanceDrop));

const owns = (stat: FileSystem.File.Info, uid: number) =>
  Option.contains(stat.uid, uid);

const readState = Effect.fn("MaintenanceInbox.readState")(function* readState(
  directory: string
) {
  const document = yield* readMaintenanceDocument(directory);
  const state = yield* Schema.decodeUnknownEffect(State)(document);

  return { document, state };
});

const save = Effect.fn("MaintenanceInbox.save")(function* save(
  directory: string,
  document: JsonDocument,
  state: typeof State.Type
) {
  const encoded = yield* Schema.encodeEffect(State)(state);

  yield* writeMaintenanceText(
    directory,
    JSON.stringify({ ...document, ...encoded })
  );
});

const readDirectory = Effect.fn("MaintenanceInbox.readDirectory")(
  function* readDirectory(inbox: Inbox["inbox"]) {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.lstat(inbox.path);

    if (
      info.type !== "Directory" ||
      !owns(info, inbox.operatorUid) ||
      /[2367].|.[2367]/u.test(info.mode.toString(8).slice(-2))
    ) {
      return yield* new FleetError({
        reason: "Maintenance inbox directory is not trusted",
      });
    }

    return yield* fs.readDirectory(inbox.path);
  }
);

const inspectDrop = Effect.fn("MaintenanceInbox.inspectDrop")(
  function* inspectDrop(file: string, uid: number) {
    const fs = yield* FileSystem.FileSystem;
    const listed = yield* fs.lstat(file);

    if (
      listed.type !== "File" ||
      listed.size > BigInt(maxBytes) ||
      !owns(listed, uid)
    ) {
      return Result.fail("invalid request file or JSON");
    }

    if (listed.mode % 4096 !== 0o640) {
      return null;
    }

    const handle = yield* fs.open(file, { flag: "r", noFollow: true });
    const stat = yield* handle.stat;

    if (
      stat.type !== "File" ||
      stat.size !== listed.size ||
      stat.mode !== listed.mode ||
      stat.dev !== listed.dev ||
      Option.isNone(stat.ino) ||
      !Option.contains(listed.ino, stat.ino.value) ||
      !owns(stat, uid)
    ) {
      return null;
    }

    const bytes = yield* handle.readAlloc(maxBytes + 1);
    const content = Option.getOrElse(bytes, () => new Uint8Array());

    if (content.byteLength !== Number(stat.size)) {
      return null;
    }

    const text = yield* Effect.try(() =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content)
    ).pipe(Effect.option);

    if (Option.isNone(text)) {
      return Result.fail("invalid request file or JSON");
    }

    const drop = decodeDrop(text.value, { onExcessProperty: "error" });

    return Option.isSome(drop)
      ? Result.succeed(drop.value)
      : Result.fail("invalid request file or JSON");
  },
  Effect.scoped,
  Effect.orElseSucceed(() => null)
);

const deadline = (raw: string) =>
  Option.filter(DateTime.make(raw), (value) => {
    const [seconds = "", fraction = ""] = raw.slice(0, -1).split(".");
    const normalized = `${seconds}.${fraction.padEnd(3, "0")}Z`;

    return DateTime.formatIso(value) === normalized;
  });

const requestDeadline = (
  id: string,
  raw: string,
  now: number
): Result.Result<number, string> => {
  const issued = Number(BigInt(id.slice(0, 20)) / 1_000_000n);

  if (issued > now || now - issued > maxAge) {
    return Result.fail("request ID timestamp is outside the last four hours");
  }

  const time = deadline(raw);

  if (Option.isNone(time)) {
    return Result.fail("invalid until");
  }

  const until = DateTime.toEpochMillis(time.value);

  return until <= now || until - now > maxAge
    ? Result.fail("request deadline must be in the next four hours")
    : Result.succeed(until);
};

const apply = (
  config: Inbox,
  windows: readonly MaintenanceWindowValue[],
  id: string,
  drop: Drop,
  now: number
): Result.Result<readonly MaintenanceWindowValue[], string> => {
  if (drop.id !== id) {
    return Result.fail("request id does not match filename");
  }

  if (
    drop.instance !== MAILBOX_INSTANCE &&
    !config.instances.includes(drop.instance)
  ) {
    return Result.fail("unknown instance");
  }

  const expires = requestDeadline(id, drop.until, now);

  if (Result.isFailure(expires)) {
    return Result.fail(expires.failure);
  }

  const open = windows.findLast(
    (window) => window.instance === drop.instance && windowOpen(window, now)
  );

  if (
    open !== undefined &&
    drop.owner !== open.owner &&
    drop.owner !== config.desk
  ) {
    return Result.fail(`${drop.action} requires the window owner or desk`);
  }

  if (drop.action === "end") {
    const ended = endWindow(windows, drop.instance, now);

    return ended === undefined
      ? Result.fail("no open window")
      : Result.succeed(ended);
  }

  return Result.succeed(
    startWindow(
      windows,
      {
        graceMinutes: DEFAULT_GRACE_MINUTES,
        instance: drop.instance,
        owner: drop.owner,
        reason: drop.reason,
        requestId: id,
        start: now,
        until: expires.success,
      },
      now
    )
  );
};

const decide = Effect.fn("MaintenanceInbox.decide")(function* decide(
  config: Inbox,
  windows: readonly MaintenanceWindowValue[],
  name: string,
  now: number
) {
  const id = name.slice(0, -5);
  const { path, operatorUid } = config.inbox;

  const drop = yield* inspectDrop(`${path}/${name}`, operatorUid);

  if (drop === null) {
    return null;
  }

  if (!Schema.is(Id)(id)) {
    return { text: "refused: invalid request filename", windows };
  }

  if (Result.isFailure(drop)) {
    return { text: `refused: ${drop.failure} (${id})`, windows };
  }

  const next = apply(config, windows, id, drop.success, now);

  if (Result.isFailure(next)) {
    return { text: `refused: ${next.failure} (${id})`, windows };
  }

  const { action, instance, owner, until } = drop.success;
  const ending = action === "start" ? ` until ${until}` : " now";

  return {
    text: `maintenance ${action} on ${instance} by ${owner}${ending} (${id})`,
    windows: next.success,
  };
});

export const ingestMaintenance = Effect.fn("MaintenanceInbox.ingest")(
  function* ingestMaintenance(config: Inbox) {
    const { document, state } = yield* readState(config.directory);
    const files = new Set(yield* readDirectory(config.inbox));
    const now = yield* Clock.currentTimeMillis;

    const entries = Object.entries(state.requests ?? {});

    const kept = entries.filter(
      ([name, notice]) =>
        files.has(name) || now - notice.decidedAt <= WINDOW_MEMORY_MS
    );

    const requests = Object.fromEntries(kept);
    let decisions = 0;
    let { windows } = state;

    for (const name of [...files].toSorted()) {
      if (decisions >= 16) {
        break;
      }

      if (
        name.startsWith(".") ||
        !name.endsWith(".json") ||
        Object.hasOwn(requests, name)
      ) {
        continue;
      }

      const decision = yield* decide(config, windows, name, now);

      if (decision !== null) {
        ({ windows } = decision);
        requests[name] = Notice.cases.Queued.make({
          at: 0,
          decidedAt: now,
          fallback: false,
          text: decision.text,
        });
        decisions += 1;
      }
    }

    if (kept.length !== entries.length || decisions > 0) {
      yield* save(config.directory, document, { ...state, requests, windows });
    }
  }
);

export const deliverMaintenance = Effect.fn("MaintenanceInbox.deliver")(
  function* deliverMaintenance<PrepareError, SendError, R>(
    directory: string,
    ports: MaintenanceNoticePorts<PrepareError, SendError, R>
  ) {
    const { document, state } = yield* readState(directory);
    const requests = { ...state.requests };

    const isTerminal = Schema.is(
      Schema.Union([Notice.cases.Sent, Notice.cases.Dropped])
    );

    const isQueued = Schema.is(Notice.cases.Queued);

    const isRefused = Schema.is(
      Schema.TaggedStruct("MaintenancePreparationRefused", {})
    );

    const pending = Object.entries(requests)
      .flatMap(([name, item]) => (isTerminal(item) ? [] : [{ item, name }]))
      .toSorted((left, right) => left.item.at - right.item.at)
      .slice(0, 4);

    const remember = (name: string, notice: NoticeValue) =>
      save(directory, document, {
        ...state,
        requests: { ...requests, [name]: notice },
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            requests[name] = notice;
          })
        )
      );

    for (const { item, name } of pending) {
      const at = yield* Clock.currentTimeMillis;
      const { decidedAt } = item;
      const stepped = { ...item, at };

      yield* remember(name, stepped);

      yield* Effect.gen(function* delivery() {
        if (isQueued(stepped)) {
          const prepared = yield* ports.prepare(stepped.text).pipe(
            Effect.flatMap((receipt) =>
              Schema.encodeEffect(MaintenanceNoticeReceipt)(receipt).pipe(
                Effect.as(receipt),
                Effect.mapError(() => new MaintenancePreparationRefused())
              )
            ),
            Effect.result
          );

          if (Result.isFailure(prepared)) {
            if (!isRefused(prepared.failure)) {
              return yield* ports.unavailable;
            }

            if (stepped.fallback) {
              yield* remember(name, Notice.cases.Dropped.make({ decidedAt }));

              return yield* ports.unavailable;
            }

            const id = name.slice(0, -5);
            const label = Schema.is(Id)(id) ? ` (${id})` : "";

            return yield* remember(
              name,
              Notice.cases.Queued.make({
                at,
                decidedAt,
                fallback: true,
                text: `maintenance notice refused: could not prepare original decision${label}`,
              })
            );
          }

          yield* remember(
            name,
            Notice.cases.Prepared.make({
              at,
              decidedAt,
              receipt: prepared.success,
            })
          );
          yield* ports.send(prepared.success);
        } else {
          yield* ports.send(stepped.receipt);
        }

        return yield* remember(name, Notice.cases.Sent.make({ decidedAt }));
      }).pipe(Effect.catch(() => ports.unavailable));
    }
  }
);
