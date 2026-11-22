import {
  Clock,
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
  endWindow,
  maintenancePath,
  startWindow,
  windowOpen,
  writeMaintenanceText,
} from "./alarm-maintenance.ts";
import type { MaintenanceWindowValue } from "./alarm-maintenance.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u));

const Iso = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u)
);

export const MaintenanceDrop = Schema.Struct({
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

const Receipt = Schema.Struct({
  envelope: EncryptedEnvelope,
  recipient: AgentName,
});

const Notice = Schema.TaggedUnion({
  Prepared: { at: Schema.Int, receipt: Receipt },
  Queued: { at: Schema.Int, text: Schema.NonEmptyString },
  Sent: {},
});

const State = Schema.Struct({
  ...MaintenanceFile.fields,
  requests: Schema.optionalKey(Schema.Record(Schema.String, Notice)),
});

const Json = Schema.fromJsonString(State);

type InboxState = typeof State.Type;

type NoticeValue = typeof Notice.Type;

type Drop = typeof MaintenanceDrop.Type;

interface Inbox {
  readonly desk: string;
  readonly directory: string;
  readonly inbox: string;
  readonly instances: readonly string[];
}

export interface MaintenanceNoticePorts<PrepareError, SendError, R> {
  readonly prepare: (
    text: string
  ) => Effect.Effect<typeof Receipt.Type, PrepareError, R>;
  readonly send: (
    receipt: typeof Receipt.Type
  ) => Effect.Effect<void, SendError, R>;
  readonly unavailable: Effect.Effect<void, never, R>;
}

const maxBytes = 4096;

const readState = Effect.fn("MaintenanceInbox.readState")(function* readState(
  directory: string
) {
  const fs = yield* FileSystem.FileSystem;
  const file = maintenancePath(directory);

  if (!(yield* fs.exists(file))) {
    return State.make({ version: 1, windows: [] });
  }

  return yield* Schema.decodeEffect(Json)(yield* fs.readFileString(file), {
    onExcessProperty: "error",
  });
});

const save = (directory: string, state: InboxState) =>
  Schema.encodeEffect(Json)(state).pipe(
    Effect.flatMap((text) => writeMaintenanceText(directory, text))
  );

const readDrop = Effect.fn("MaintenanceInbox.readDrop")(
  function* readDrop(file: string) {
    const fs = yield* FileSystem.FileSystem;
    const listed = yield* fs.lstat(file);

    if (
      listed.type !== "File" ||
      listed.size > BigInt(maxBytes) ||
      ![0o440, 0o444, 0o640, 0o644].includes(listed.mode % 512)
    ) {
      return Option.none<Drop>();
    }

    const handle = yield* fs.open(file, { flag: "r", noFollow: true });
    const stat = yield* handle.stat;

    if (
      stat.type !== "File" ||
      stat.size !== listed.size ||
      stat.mode !== listed.mode
    ) {
      return Option.none<Drop>();
    }

    const bytes = yield* handle.readAlloc(maxBytes + 1);

    if (Option.isNone(bytes) || bytes.value.byteLength !== Number(stat.size)) {
      return Option.none<Drop>();
    }

    const text = yield* Effect.try(() =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.value
      )
    );

    return Schema.decodeOption(Schema.fromJsonString(MaintenanceDrop))(text, {
      onExcessProperty: "error",
    });
  },
  Effect.scoped,
  Effect.orElseSucceed(() => Option.none<Drop>())
);

const deadline = (raw: string) =>
  Option.filter(DateTime.make(raw), (value) => {
    const normalized = raw.replace(
      /(?:\.(?<digits>\d{1,3}))?Z$/u,
      (_, digits: string | undefined) => `.${(digits ?? "").padEnd(3, "0")}Z`
    );

    return DateTime.formatIso(value) === normalized;
  });

const apply = (
  config: Inbox,
  windows: readonly MaintenanceWindowValue[],
  id: string,
  drop: Drop,
  now: number
) => {
  if (drop.id !== id) {
    return Result.fail("request id does not match filename");
  }

  if (
    drop.instance !== MAILBOX_INSTANCE &&
    !config.instances.includes(drop.instance)
  ) {
    return Result.fail("unknown instance");
  }

  const time = deadline(drop.until);

  if (Option.isNone(time)) {
    return Result.fail("invalid until");
  }

  const until = DateTime.toEpochMillis(time.value);

  if (until <= now || until - now > 4 * 3_600_000) {
    return Result.fail("until must be in the next four hours");
  }

  if (drop.action === "start") {
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
          until,
        },
        now
      )
    );
  }

  const open = windows.findLast(
    (window) => window.instance === drop.instance && windowOpen(window, now)
  );

  if (open === undefined) {
    return Result.fail("no open window");
  }

  if (drop.owner !== open.owner && drop.owner !== config.desk) {
    return Result.fail("end requires the window owner or desk");
  }

  const ended = endWindow(windows, drop.instance, now);

  return ended === undefined
    ? Result.fail("no open window")
    : Result.succeed(ended);
};

const decide = Effect.fn("MaintenanceInbox.decide")(function* decide(
  config: Inbox,
  windows: readonly MaintenanceWindowValue[],
  name: string,
  now: number
) {
  const id = name.slice(0, -5);

  if (!Schema.is(Id)(id) || id.endsWith("\n")) {
    return { text: "refused: invalid request filename", windows };
  }

  const drop = yield* readDrop(`${config.inbox}/${name}`);

  if (Option.isNone(drop)) {
    return { text: `refused: invalid request file or JSON (${id})`, windows };
  }

  const next = apply(config, windows, id, drop.value, now);

  if (Result.isFailure(next)) {
    return { text: `refused: ${next.failure} (${id})`, windows };
  }

  const { action, instance, owner, until } = drop.value;

  return {
    text: `maintenance ${action} on ${instance} by ${owner} until ${until} (${id})`,
    windows: next.success,
  };
});

export const ingestMaintenance = Effect.fn("MaintenanceInbox.ingest")(
  function* ingestMaintenance(config: Inbox) {
    const fs = yield* FileSystem.FileSystem;
    const prior = yield* readState(config.directory);
    const requests = { ...prior.requests };

    const files = (yield* fs.readDirectory(config.inbox))
      .filter(
        (name) =>
          !name.startsWith(".") &&
          name.endsWith(".json") &&
          !Object.hasOwn(requests, name)
      )
      .toSorted()
      .slice(0, 16);

    const now = yield* Clock.currentTimeMillis;
    let { windows } = prior;

    for (const name of files) {
      const decision = yield* decide(config, windows, name, now);
      ({ windows } = decision);
      requests[name] = Notice.cases.Queued.make({ at: 0, text: decision.text });
    }

    if (files.length > 0) {
      yield* save(config.directory, { ...prior, requests, windows });
    }
  }
);

export const deliverMaintenance = Effect.fn("MaintenanceInbox.deliver")(
  function* deliverMaintenance<PrepareError, SendError, R>(
    directory: string,
    ports: MaintenanceNoticePorts<PrepareError, SendError, R>
  ) {
    const state = yield* readState(directory);
    const requests = { ...state.requests };
    const isSent = Schema.is(Notice.cases.Sent);
    const isQueued = Schema.is(Notice.cases.Queued);

    const pending = Object.entries(requests)
      .flatMap(([name, item]) => (isSent(item) ? [] : [{ item, name }]))
      .toSorted((left, right) => left.item.at - right.item.at)
      .slice(0, 4);

    const remember = (name: string, notice: NoticeValue) => {
      requests[name] = notice;

      return save(directory, { ...state, requests });
    };

    for (const { item, name } of pending) {
      const at = yield* Clock.currentTimeMillis;
      const stepped = { ...item, at };
      yield* remember(name, stepped);

      yield* Effect.gen(function* delivery() {
        const receipt = isQueued(stepped)
          ? yield* ports.prepare(stepped.text)
          : stepped.receipt;

        if (isQueued(stepped)) {
          yield* remember(name, Notice.cases.Prepared.make({ at, receipt }));
        }

        yield* ports.send(receipt);
        yield* remember(name, Notice.cases.Sent.make({}));
      }).pipe(Effect.catch(() => ports.unavailable));
    }
  }
);
