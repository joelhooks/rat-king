import {
  Clock,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Match,
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
  coverEnd,
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

const validId = Schema.is(Id);

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

const Decision = Schema.Struct({
  ended: Schema.optionalKey(Schema.Finite),
  instance: Schema.optionalKey(MaintenanceDrop.fields.instance),
  outcome: Schema.Literals(["applied", "refused"]),
  owner: Schema.optionalKey(AgentName),
  start: Schema.optionalKey(Schema.Finite),
  until: Schema.optionalKey(Schema.Finite),
});

const noticeFields = {
  decidedAt: Schema.Int,
  decision: Schema.optionalKey(Decision),
};

const pendingFields = {
  ...noticeFields,
  at: Schema.Int,
  deferred: Schema.optionalKey(Schema.Literal(true)),
};

const Notice = Schema.TaggedUnion({
  Dropped: noticeFields,
  Prepared: { ...pendingFields, receipt: MaintenanceNoticeReceipt },
  Queued: {
    ...pendingFields,
    fallback: Schema.Boolean,
    text: Schema.NonEmptyString,
  },
  Sent: noticeFields,
});

const State = Schema.Struct({
  ...MaintenanceFile.fields,
  clockDeferred: Schema.optionalKey(Schema.Array(Schema.String)),
  requests: Schema.optionalKey(Schema.Record(Schema.String, Notice)),
});

type NoticeValue = typeof Notice.Type;

type Drop = typeof MaintenanceDrop.Type;

export class MaintenancePreparationRefused extends Data.TaggedError(
  "MaintenancePreparationRefused"
) {}

interface Inbox {
  readonly alarmGid: number | undefined;
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

const badDropAfter = 10 * 60_000;

const maxClockSkew = 5 * 60_000;

const decodeDrop = Schema.decodeOption(Schema.fromJsonString(MaintenanceDrop));

const owns = (stat: FileSystem.File.Info, uid: number) =>
  Option.contains(stat.uid, uid);

const isTerminal = Schema.is(
  Schema.Union([Notice.cases.Sent, Notice.cases.Dropped])
);

const issuedAt = (id: string) => Number(BigInt(id.slice(0, 20)) / 1_000_000n);

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

const StatusInstance = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u)
);

const StatusOwner = AgentName.check(Schema.isMaxLength(128));

interface SubjectStatus {
  instance?: string | undefined;
  owner?: string | undefined;
}

const publicSubject = (item: Readonly<SubjectStatus>) => {
  const output: SubjectStatus = {};

  if (Schema.is(StatusInstance)(item.instance)) {
    output.instance = item.instance;
  }

  if (Schema.is(StatusOwner)(item.owner)) {
    output.owner = item.owner;
  }

  return output;
};

const deliveryStatus = (notice: NoticeValue) =>
  Match.value(notice).pipe(
    Match.tagsExhaustive({
      Dropped: () => "dropped",
      Prepared: (item) => (item.deferred === true ? "deferred" : "prepared"),
      Queued: (item) => (item.deferred === true ? "deferred" : "queued"),
      Sent: () => "sent",
    })
  );

const requestStatus = (id: string, item: NoticeValue) => {
  const { outcome, owner, instance, ...times } = item.decision ?? {
    outcome: "unknown" as const,
  };

  return {
    ...times,
    ...publicSubject({ instance, owner }),
    decidedAt: item.decidedAt,
    decision: outcome,
    delivery: deliveryStatus(item),
    id,
  };
};

export const maintenanceStatusRows = Effect.fn("Maintenance.statusRows")(
  function* maintenanceStatusRows(directory: string, now: number) {
    const { state } = yield* readState(directory);

    const windows = state.windows
      .filter((window) => window.start <= now && coverEnd(window) >= now)
      .toSorted((a, b) => b.start - a.start);

    const requests = Object.entries(state.requests ?? {})
      .toSorted(([, a], [, b]) => b.decidedAt - a.decidedAt)
      .flatMap(([file, item]) => {
        const id = file.slice(0, -5);

        return file.endsWith(".json") && validId(id)
          ? [requestStatus(id, item)]
          : [];
      });

    const deferred = (state.clockDeferred ?? []).flatMap((file) => {
      const id = file.slice(0, -5);

      return file.endsWith(".json") &&
        validId(id) &&
        !Object.hasOwn(state.requests ?? {}, file)
        ? [{ decision: "deferred" as const, delivery: null, id }]
        : [];
    });

    return {
      requests: [...deferred, ...requests].slice(0, 128),
      truncated: windows.length > 64 || deferred.length + requests.length > 128,
      windows: windows.slice(0, 64).map((window) => {
        const { start, until, ended, requestId } = window;
        const view = { ...publicSubject(window), ended, start, until };

        return validId(requestId) ? { ...view, id: requestId } : view;
      }),
    };
  }
);

const readDirectory = Effect.fn("MaintenanceInbox.readDirectory")(
  function* readDirectory({ alarmGid, inbox }: Inbox) {
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

    if (alarmGid === undefined || !Option.contains(info.gid, alarmGid)) {
      return yield* new FleetError({
        reason: "Maintenance inbox group does not match the alarm group",
      });
    }

    return { files: yield* fs.readDirectory(inbox.path), gid: alarmGid };
  }
);

const inspectDrop = Effect.fn("MaintenanceInbox.inspectDrop")(
  function* inspectDrop(file: string, uid: number, gid: number) {
    const fs = yield* FileSystem.FileSystem;
    const listed = yield* fs.lstat(file);

    if (listed.type !== "File" || listed.size > BigInt(maxBytes)) {
      return Result.fail("invalid request file or JSON");
    }

    if (
      listed.mode % 4096 !== 0o640 ||
      !owns(listed, uid) ||
      !Option.contains(listed.gid, gid)
    ) {
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
      !owns(stat, uid) ||
      !Option.contains(stat.gid, gid)
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
  const issued = issuedAt(id);

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

const cancellationIndex = Effect.fn("MaintenanceInbox.ends")(
  function* cancellationIndex(
    config: Inbox,
    names: readonly string[],
    gid: number,
    now: number
  ) {
    const ends = new Map<string, Map<string, string>>();
    const { operatorUid, path } = config.inbox;

    for (const name of names) {
      const id = name.slice(0, -5);

      if (
        !name.endsWith(".json") ||
        !validId(id) ||
        now - issuedAt(id) > maxAge ||
        issuedAt(id) > now
      ) {
        continue;
      }

      const drop = yield* inspectDrop(`${path}/${name}`, operatorUid, gid);

      if (
        drop === null ||
        Result.isFailure(drop) ||
        drop.success.action !== "end" ||
        drop.success.id !== id
      ) {
        continue;
      }

      const until = deadline(drop.success.until).pipe(
        Option.map(DateTime.toEpochMillis)
      );

      const issued = issuedAt(id);

      if (
        Option.isNone(until) ||
        until.value <= issued ||
        until.value - issued > maxAge + 1000
      ) {
        continue;
      }

      const { instance, owner } = drop.success;
      const owners = ends.get(instance) ?? new Map<string, string>();
      owners.set(owner, id);
      ends.set(instance, owners);
    }

    return ends;
  }
);

const decisionOf = (
  drop: Drop,
  windows: readonly MaintenanceWindowValue[],
  now: number
): typeof Decision.Type => {
  const window = windows.findLast((item) =>
    drop.action === "start"
      ? item.requestId === drop.id
      : item.instance === drop.instance && item.ended === now
  );

  const base = {
    instance: drop.instance,
    outcome: "applied" as const,
    owner: drop.owner,
  };

  if (window === undefined) {
    return base;
  }

  const timed = { ...base, start: window.start, until: window.until };

  return window.ended === undefined ? timed : { ...timed, ended: window.ended };
};

const decide = Effect.fn("MaintenanceInbox.decide")(function* decide(
  config: Inbox,
  windows: readonly MaintenanceWindowValue[],
  id: string,
  drop: Result.Result<Drop, string> | null,
  now: number,
  ends: ReturnType<typeof cancellationIndex>
) {
  const refused = { outcome: "refused" as const };

  const metadata =
    drop !== null && Result.isSuccess(drop) && drop.success.id === id
      ? { ...refused, owner: drop.success.owner }
      : refused;

  const refuse = (reason: string) => ({
    decision: metadata,
    text: `refused: ${reason} (${id})`,
    windows,
  });

  if (!validId(id)) {
    return {
      decision: refused,
      text: "refused: invalid request filename",
      windows,
    };
  }

  if (drop === null) {
    return now - issuedAt(id) > badDropAfter
      ? refuse("request unreadable or wrong owner, group or mode")
      : null;
  }

  if (Result.isFailure(drop)) {
    return refuse(drop.failure);
  }

  const { action, instance, owner, until } = drop.success;
  const next = apply(config, windows, id, drop.success, now);

  if (Result.isFailure(next)) {
    return refuse(next.failure);
  }

  if (action === "start") {
    const cancellations = (yield* ends).get(instance);

    const cancelled =
      (cancellations?.get(owner) ?? "") > id ||
      (cancellations?.get(config.desk) ?? "") > id;

    if (cancelled) {
      return refuse("start superseded by a later end");
    }
  }

  const ending = action === "start" ? ` until ${until}` : " now";

  return {
    decision: decisionOf(drop.success, next.success, now),
    text: `maintenance ${action} on ${instance} by ${owner}${ending} (${id})`,
    windows: next.success,
  };
});

export const ingestMaintenance = Effect.fn("MaintenanceInbox.ingest")(
  function* ingestMaintenance(config: Inbox) {
    const { document, state } = yield* readState(config.directory);
    const { files: entriesOnDisk, gid } = yield* readDirectory(config);
    const files = new Set(entriesOnDisk);
    const now = yield* Clock.currentTimeMillis;
    const names = [...files].toSorted();

    const ends = yield* Effect.cached(
      cancellationIndex(config, names, gid, now)
    );

    const previousDeferred = new Set(state.clockDeferred);
    const deferred = new Set(previousDeferred);

    const entries = Object.entries(state.requests ?? {});

    const kept = entries.filter(
      ([name, notice]) =>
        !isTerminal(notice) ||
        files.has(name) ||
        now - notice.decidedAt <= WINDOW_MEMORY_MS
    );

    const requests = Object.fromEntries(kept);
    let decisions = 0;
    let { windows } = state;

    for (const name of names) {
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

      const id = name.slice(0, -5);
      const ahead = validId(id) ? issuedAt(id) - now : 0;

      if (ahead > 0 && (ahead <= maxClockSkew || !previousDeferred.has(name))) {
        deferred.add(name);
        continue;
      }

      deferred.delete(name);

      const { path, operatorUid } = config.inbox;

      const drop =
        ahead > 0
          ? Result.fail("request ID timestamp is more than five minutes ahead")
          : yield* inspectDrop(`${path}/${name}`, operatorUid, gid);

      const decision = yield* decide(config, windows, id, drop, now, ends);

      if (decision !== null) {
        ({ windows } = decision);
        requests[name] = Notice.cases.Queued.make({
          at: 0,
          decidedAt: now,
          decision: decision.decision,
          fallback: false,
          text: decision.text,
        });
        decisions += 1;
      }
    }

    const clockDeferred = [...deferred].filter((name) => files.has(name));

    if (
      kept.length !== entries.length ||
      decisions > 0 ||
      clockDeferred.length !== previousDeferred.size ||
      clockDeferred.some((name) => !previousDeferred.has(name))
    ) {
      yield* save(config.directory, document, {
        ...state,
        clockDeferred,
        requests,
        windows,
      });
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

      const history =
        item.decision === undefined
          ? { decidedAt: item.decidedAt }
          : { decidedAt: item.decidedAt, decision: item.decision };

      const stepped = { ...item, at, deferred: true as const };

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
              yield* remember(name, Notice.cases.Dropped.make(history));

              return yield* ports.unavailable;
            }

            const id = name.slice(0, -5);
            const label = Schema.is(Id)(id) ? ` (${id})` : "";

            return yield* remember(
              name,
              Notice.cases.Queued.make({
                ...history,
                at,
                deferred: true,
                fallback: true,
                text: `maintenance notice refused: could not prepare original decision${label}`,
              })
            );
          }

          yield* remember(
            name,
            Notice.cases.Prepared.make({
              ...history,
              at,
              deferred: true,
              receipt: prepared.success,
            })
          );
          yield* ports.send(prepared.success);
        } else {
          yield* ports.send(stepped.receipt);
        }

        return yield* remember(name, Notice.cases.Sent.make(history));
      }).pipe(Effect.catch(() => ports.unavailable));
    }
  }
);
