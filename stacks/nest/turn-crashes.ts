import {
  Array as Arr,
  Effect,
  Clock,
  FileSystem,
  Random,
  Result,
  Schedule,
  Schema,
} from "effect";

import { Turn } from "../../packages/lexicon/turns.ts";
import type { TurnValue } from "../../packages/lexicon/turns.ts";
import { collectReaderHeartbeats } from "./alarm-collector.ts";
import {
  AlarmRefused,
  prepareAlarmMail,
  sendAlarmDelivery,
} from "./alarm-mail.ts";
import type { ReaderWindowFacts } from "./alarm-reader-windows.ts";
import { Delivery } from "./alarm.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

export interface CrashNotice {
  readonly owner: string;
  readonly record: TurnValue;
}

export interface CrashEntry<D> {
  readonly attempts?: number;
  readonly delivery: D;
  readonly key: string;
  readonly nextAt?: number;
  readonly notice?: CrashNotice;
  readonly readdressed?: boolean;
}

export interface CrashDrop {
  readonly key: string;
  readonly reason: string;
}

export interface CrashJournalValue<D> {
  readonly dropped?: readonly CrashDrop[];
  readonly pending: readonly CrashEntry<D>[];
  readonly sent: readonly string[];
  readonly version: "0.1";
}

export interface CrashPorts<D, E, R> {
  readonly prepare: (notice: CrashNotice) => Effect.Effect<D, E, R>;
  readonly readdress: (
    notice: CrashNotice,
    successor: string
  ) => Effect.Effect<D, E, R>;
  readonly save: (journal: CrashJournalValue<D>) => Effect.Effect<void, E, R>;
  readonly send: (delivery: D) => Effect.Effect<void, E | AlarmRefused, R>;
}

export const crashRetryFloorMs = 2000;

export const crashRetryCapMs = 600_000;

export const crashBackoffMs = (attempts: number, jitter: number) =>
  Math.min(
    crashRetryCapMs,
    crashRetryFloorMs * 2 ** Math.max(0, attempts - 1)
  ) *
  (1 - jitter / 2);

const Notice = Schema.Struct({ owner: Schema.String, record: Turn });

export const CrashJournal = Schema.fromJsonString(
  Schema.Struct({
    dropped: Schema.optionalKey(
      Schema.Array(Schema.Struct({ key: Schema.String, reason: Schema.String }))
    ),
    pending: Schema.Array(
      Schema.Struct({
        attempts: Schema.optionalKey(Schema.Int),
        delivery: Delivery,
        key: Schema.String,
        nextAt: Schema.optionalKey(Schema.Finite),
        notice: Schema.optionalKey(Notice),
        readdressed: Schema.optionalKey(Schema.Boolean),
      })
    ),
    sent: Schema.Array(Schema.String),
    version: Schema.Literal("0.1"),
  })
);

type OperatorJournal = CrashJournalValue<typeof Delivery.Type>;

const emptyJournal: OperatorJournal = { pending: [], sent: [], version: "0.1" };

export const freshCrashes = (
  notices: readonly CrashNotice[],
  seen: ReadonlySet<string>
) => {
  const unique = new Map<string, CrashNotice>();

  for (const notice of notices) {
    const key = `${notice.record.agent}:${notice.record.generation}`;

    if (!seen.has(key)) {
      unique.set(key, notice);
    }
  }

  return [...unique];
};

export const crashCycle = Effect.fn("Alarm.crashCycle")(function* crashCycle<
  D,
  E,
  R,
>(
  notices: readonly CrashNotice[],
  prior: CrashJournalValue<D>,
  ports: CrashPorts<D, E, R>
) {
  let next = prior;

  const known = new Set([
    ...prior.sent,
    ...prior.pending.map((entry) => entry.key),
  ]);

  const append = (entry: CrashEntry<D>) => ({
    ...next,
    pending: Arr.append(next.pending, entry),
  });

  for (const [key, notice] of freshCrashes(notices, known)) {
    const prepared = yield* ports.prepare(notice).pipe(Effect.result);

    if (Result.isSuccess(prepared)) {
      next = append({ delivery: prepared.success, key, notice });
      yield* ports.save(next);
    } else {
      yield* Effect.logWarning(
        "Crash record preparation failed",
        prepared.failure
      );
    }
  }

  const replace = (entry: CrashEntry<D>, changed: CrashEntry<D>) => ({
    ...next,
    pending: next.pending.map((pending) =>
      pending.key === entry.key ? changed : pending
    ),
  });

  const settle = (entry: CrashEntry<D>, dropped?: string) => {
    const pending = next.pending.filter(
      (candidate) => candidate.key !== entry.key
    );

    const sent = Arr.append(next.sent, entry.key);

    if (dropped === undefined) {
      return { ...next, pending, sent };
    }

    return {
      ...next,
      dropped: Arr.append(next.dropped ?? [], {
        key: entry.key,
        reason: dropped,
      }),
      pending,
      sent,
    };
  };

  const backoff = Effect.fnUntraced(function* backoff(
    entry: CrashEntry<D>,
    now: number,
    failure: E | AlarmRefused
  ) {
    const attempts = (entry.attempts ?? 0) + 1;
    const delay = crashBackoffMs(attempts, yield* Random.next);

    if (attempts === 1) {
      yield* Effect.logWarning(
        "Crash record send failed; sealed envelope retained, retrying with backoff",
        failure
      );
    }

    next = replace(entry, { ...entry, attempts, nextAt: now + delay });
    yield* ports.save(next);
  });

  for (const entry of next.pending) {
    const now = yield* Clock.currentTimeMillis;

    if (entry.nextAt !== undefined && entry.nextAt > now) {
      continue;
    }

    const sent = yield* ports.send(entry.delivery).pipe(Effect.result);

    if (Result.isSuccess(sent)) {
      if ((entry.attempts ?? 0) > 0) {
        yield* Effect.logInfo(
          `Crash record delivered after ${entry.attempts} failed attempts: ${entry.key}`
        );
      }

      next = settle(entry);
      yield* ports.save(next);
    } else if (sent.failure instanceof AlarmRefused) {
      const refusal = sent.failure;
      const { successor } = refusal;

      if (
        successor !== undefined &&
        entry.notice !== undefined &&
        entry.readdressed !== true
      ) {
        const delivery = yield* ports
          .readdress(entry.notice, successor)
          .pipe(Effect.result);

        if (Result.isSuccess(delivery)) {
          yield* Effect.logWarning(
            `Crash record ${entry.key} re-addressed from ${entry.notice.owner} (${refusal.code}) to ${successor}`
          );
          next = replace(entry, {
            ...entry,
            delivery: delivery.success,
            notice: { ...entry.notice, owner: successor },
            readdressed: true,
          });
          yield* ports.save(next);
        } else {
          yield* backoff(entry, now, delivery.failure);
        }

        continue;
      }

      const reason = `${refusal.code}${
        successor === undefined ? "" : ` (successor ${successor})`
      }; no further delivery`;

      yield* Effect.logWarning(`Crash record ${entry.key} dropped: ${reason}`);
      next = settle(entry, reason);
      yield* ports.save(next);
    } else {
      yield* backoff(entry, now, sent.failure);
    }
  }

  return next;
});

const prepareCrash = Effect.fn("Alarm.prepareCrash")(function* prepareCrash(
  config: StageConfigValue,
  notice: CrashNotice
) {
  const prepared = yield* prepareAlarmMail(config, [notice.owner], "");
  const target = prepared.targets.find((item) => item.name === notice.owner);

  if (target === undefined) {
    return yield* new FleetError({ reason: "Crash record owner unresolved" });
  }

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Turn))(
    notice.record
  );

  return {
    envelope: yield* prepared.client.seal(target.did, body, { encrypt: false }),
    key: "readers.stuck" as const,
    recipient: notice.owner,
  };
}, Effect.scoped);

export const readerCrashSources = (config: Pick<StageConfigValue, "alarm">) =>
  config.alarm?.turnRecords === true
    ? config.alarm.readerHeartbeats
    : undefined;

export const watchReaderCrashes = Effect.fn("Alarm.watchReaderCrashes")(
  function* watchReaderCrashes<R>(
    config: StageConfigValue,
    directory: string,
    windows: Effect.Effect<ReaderWindowFacts | null, never, R> = Effect.succeed(
      {}
    )
  ) {
    const sources = readerCrashSources(config);

    if (sources === undefined) {
      return yield* Effect.void;
    }

    const fs = yield* FileSystem.FileSystem;
    const file = `${directory}/turn-crashes.json`;

    const read = Effect.gen(function* readJournal() {
      if (!(yield* fs.exists(file))) {
        return emptyJournal;
      }

      if (
        (yield* fs.stat(file)).mode % 0o1000 !== 0o600 ||
        (yield* fs.realPath(file)) !== file
      ) {
        return yield* new FleetError({
          reason: "Crash journal must be a private owned file",
        });
      }

      return yield* Schema.decodeEffect(CrashJournal)(
        yield* fs.readFileString(file)
      );
    });

    const save = Effect.fn("Alarm.saveCrashes")(function* save(
      journal: OperatorJournal
    ) {
      const text = yield* Schema.encodeEffect(CrashJournal)(journal);

      yield* Effect.gen(function* syncJournal() {
        const handle = yield* fs.open(`${file}.tmp`, {
          flag: "w",
          mode: 0o600,
        });

        yield* handle.writeAll(new TextEncoder().encode(text));
        yield* handle.sync;
      }).pipe(Effect.scoped);
      yield* fs.rename(`${file}.tmp`, file);
    });

    const ports: CrashPorts<
      typeof Delivery.Type,
      FleetError,
      Effect.Services<ReturnType<typeof prepareCrash>>
    > = {
      prepare: (notice) =>
        prepareCrash(config, notice).pipe(
          Effect.timeout("2 seconds"),
          Effect.mapError(
            () => new FleetError({ reason: "Crash record preparation failed" })
          )
        ),
      readdress: (notice, successor) =>
        prepareCrash(config, { ...notice, owner: successor }).pipe(
          Effect.timeout("2 seconds"),
          Effect.mapError(
            () => new FleetError({ reason: "Crash record preparation failed" })
          )
        ),
      save: (journal) =>
        save(journal).pipe(
          Effect.mapError(
            () => new FleetError({ reason: "Crash journal write failed" })
          )
        ),
      send: (delivery) =>
        sendAlarmDelivery(config, delivery).pipe(
          Effect.timeout("2 seconds"),
          Effect.mapError((failure) =>
            failure instanceof AlarmRefused
              ? failure
              : new FleetError({ reason: "Crash record delivery failed" })
          )
        ),
    };

    const pass = Effect.gen(function* pass() {
      const currentWindows = yield* windows;

      if (currentWindows === null) {
        return;
      }

      const observations = yield* Effect.forEach(
        sources,
        (source) =>
          collectReaderHeartbeats(source, currentWindows).pipe(
            Effect.timeout("2 seconds"),
            Effect.catchCause(() => Effect.succeed({ crashes: [], seen: [] }))
          ),
        { concurrency: "unbounded" }
      );

      yield* crashCycle(
        observations.flatMap((observation) => observation.crashes),
        yield* read,
        ports
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Reader crash notification failed", cause)
      )
    );

    yield* pass.pipe(
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.forkScoped
    );

    return yield* Effect.void;
  }
);
