import {
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { shellQuote } from "../../packages/alchemy-nest/src/ssh.ts";
import { HeartbeatJson } from "../../packages/ratking-client/src/reader-health.ts";
import { collectSessionsBackup } from "./alarm-backups.ts";
import { collectInstanceHealth } from "./alarm-instances.ts";
import { collectRecallCanary } from "./alarm-recall.ts";
import type { DeployMarker, WindowReceipt } from "./alarm-sources.ts";
import { AlarmFacts, CacheBreach, sightReaders } from "./alarm-sources.ts";
import type { WakeSighting, WakeTarget } from "./alarm-wakes.ts";
import { collectComms } from "./comms.ts";
import { configDoctor } from "./config-doctor.ts";
import { FleetDigest } from "./digest.ts";
import type { HealthDigest } from "./health.ts";
import { ShipReceipt } from "./ship-config.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";
import { crashedReader } from "./turn-crash-record.ts";

type CacheBreachValue = typeof CacheBreach.Type;

type WindowReceiptValue = typeof WindowReceipt.Type;

const HeartbeatLine = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("now"), now: Schema.Finite }),
  Schema.Struct({
    alive: Schema.Boolean,
    kind: Schema.Literal("beat"),
    text: Schema.String,
  }),
]);

export const READER_PROBE_LIMIT = "30 seconds";

export const collectReaderHeartbeats = Effect.fn(
  "Alarm.collectReaderHeartbeats"
)(
  function* readHeartbeats(source: {
    readonly dir: string;
    readonly host: string;
    readonly ssh?: string;
  }) {
    const fs = yield* FileSystem.FileSystem;

    const script = yield* fs.readFileString(
      new URL("reader-heartbeats.py", import.meta.url).pathname
    );

    const [command, args] =
      source.ssh === undefined
        ? ["python3", ["-I", "-c", script, source.dir]]
        : [
            "ssh",
            [
              "-o",
              "BatchMode=yes",
              "-o",
              "StrictHostKeyChecking=yes",
              "-o",
              "ConnectTimeout=5",
              "--",
              source.ssh,
              `python3 -I -c ${shellQuote(script)} ${shellQuote(source.dir)}`,
            ],
          ];

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, { stdin: "ignore" })
    );

    const [lines, code] = yield* Effect.all(
      [
        handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.length > 0),
          Stream.mapEffect((line) =>
            Schema.decodeEffect(Schema.fromJsonString(HeartbeatLine))(line)
          ),
          Stream.runCollect
        ),
        handle.exitCode,
        Stream.runDrain(handle.stderr),
      ],
      { concurrency: "unbounded" }
    );

    const now = lines.find((line) => line.kind === "now");

    if (code !== 0 || now === undefined || now.kind !== "now") {
      return yield* new FleetError({ reason: "Reader heartbeats unreadable" });
    }

    const beats = lines.flatMap((line) =>
      line.kind === "beat"
        ? Result.match(Schema.decodeResult(HeartbeatJson)(line.text), {
            onFailure: () => [],
            onSuccess: (beat) => [{ alive: line.alive, beat }],
          })
        : []
    );

    return {
      crashes: beats.flatMap(({ beat }) => {
        const record = crashedReader(beat, now.now);

        return record === undefined || beat.owner === undefined
          ? []
          : [{ owner: beat.owner, record }];
      }),
      seen: sightReaders(source.host, beats, now.now),
      targets: beats.map(({ beat }) => ({
        name: beat.name,
        owner: beat.owner ?? null,
      })),
    };
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: READER_PROBE_LIMIT,
        orElse: () =>
          Effect.fail(
            new FleetError({ reason: "Reader heartbeats timed out" })
          ),
      }),
      Effect.mapError(
        () => new FleetError({ reason: "Reader heartbeats unavailable" })
      )
    )
);

export const readHeartbeats = (source: {
  readonly dir: string;
  readonly host: string;
  readonly ssh?: string;
}) => collectReaderHeartbeats(source).pipe(Effect.map((value) => value.seen));

const observeReaders = (
  sources: NonNullable<StageConfigValue["alarm"]>["readerHeartbeats"]
) =>
  sources === undefined
    ? Effect.succeed({ facts: null, failed: [], targets: undefined })
    : Effect.forEach(
        sources,
        (source) => collectReaderHeartbeats(source).pipe(Effect.option),
        { concurrency: "unbounded" }
      ).pipe(
        Effect.map((hosts) => {
          const complete = hosts.every(Option.isSome);

          return {
            facts: {
              complete,
              seen: hosts.flatMap((host) =>
                Option.match(host, {
                  onNone: () => [],
                  onSome: (value) => value.seen,
                })
              ),
            },
            failed: sources.flatMap((source, index) =>
              Option.isNone(hosts[index] ?? Option.none())
                ? [`readers@${source.host}`]
                : []
            ),
            targets: hosts.flatMap((host) =>
              Option.match(host, {
                onNone: () => [],
                onSome: (value) => value.targets,
              })
            ),
          };
        })
      );

const probe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout("30 seconds"),
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeed(Option.none<A>()))
  );

const unavailable = (
  measured: Readonly<Record<string, Option.Option<unknown>>>
) =>
  Object.entries(measured)
    .filter(([, value]) => Option.isNone(value))
    .map(([name]) => name);

const backupWindowOf = (digest: HealthDigest | null) => {
  const run = digest?.backup.lastRun ?? null;

  if (run === null || run.startedAt === null) {
    return null;
  }

  const start = DateTime.toEpochMillis(run.startedAt);

  if (run.endedAt === null || DateTime.toEpochMillis(run.endedAt) < start) {
    return { end: null, start };
  }

  return { end: DateTime.toEpochMillis(run.endedAt), start };
};

const collectorPorts = { comms: collectComms, doctor: configDoctor };

export const collectAlarmFacts = Effect.fn("Alarm.collect")(
  function* collectAlarmFacts<E, R, E2, R2, R3 = never, E4 = never, R4 = never>(
    config: StageConfigValue,
    health: Effect.Effect<HealthDigest, E, R>,
    deploy: Effect.Effect<typeof DeployMarker.Type | null, E2, R2>,
    wakeHealth: (
      readers: readonly (typeof WakeTarget.Type)[] | undefined
    ) => Effect.Effect<
      readonly (typeof WakeSighting.Type)[] | null,
      never,
      R3
    > = () => Effect.succeed(null),
    windows: Effect.Effect<
      readonly WindowReceiptValue[],
      E4,
      R4
    > = Effect.succeed([]),
    ports: {
      readonly comms: typeof collectComms;
      readonly doctor: typeof configDoctor;
    } = collectorPorts
  ) {
    if (config.alarm === undefined || config.ship === undefined) {
      return yield* new FleetError({
        reason: "Alarm and ship configuration required",
      });
    }

    const { ship } = config;
    const fs = yield* FileSystem.FileSystem;
    const now = yield* Clock.currentTimeMillis;

    const observations = yield* Effect.all(
      {
        cache: Option.match(Option.fromNullishOr(config.alarm.cacheHealth), {
          onNone: () =>
            Effect.succeed(Option.none<readonly CacheBreachValue[]>()),
          onSome: (file) =>
            fs.readFileString(file).pipe(
              Effect.map((text) =>
                text
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .flatMap((line) =>
                    Result.match(
                      Schema.decodeResult(Schema.fromJsonString(CacheBreach))(
                        line
                      ),
                      { onFailure: () => [], onSuccess: (breach) => [breach] }
                    )
                  )
              ),
              Effect.option
            ),
        }),
        deploy: probe(deploy),
        digest: fs
          .exists(`${config.runtime.RAT_KING_STATE_DIR}/health.jsonl`)
          .pipe(
            Effect.flatMap((exists) =>
              exists
                ? fs.readFileString(
                    `${config.runtime.RAT_KING_STATE_DIR}/health.jsonl`
                  )
                : Effect.succeed("")
            ),
            Effect.flatMap((text) => {
              const last = text.trim().split("\n").at(-1);

              return last === undefined || last === ""
                ? Effect.succeed(null)
                : Schema.decodeEffect(Schema.fromJsonString(FleetDigest))(last);
            }),
            Effect.option
          ),
        doctor: probe(ports.doctor(config)),
        health: probe(health),
        instances: collectInstanceHealth(config.alarm.instances),
        quarantine: Effect.all(
          [
            ports.comms(config.comms.local, now - 3_600_000, true),
            ports.comms(config.comms.remote, now - 3_600_000, true),
          ],
          { concurrency: "unbounded" }
        ).pipe(
          Effect.map((counts) =>
            counts.reduce((total, count) => total + count.quarantined, 0)
          ),
          Effect.timeout("30 seconds"),
          Effect.option
        ),
        readers: observeReaders(config.alarm.readerHeartbeats),
        recallCanary:
          config.alarm.recallCanary === undefined
            ? Effect.succeed("off" as const)
            : collectRecallCanary(config.alarm.recallCanary),
        receipts: fs.exists(config.ship.receipts).pipe(
          Effect.flatMap((exists) =>
            exists
              ? fs.readFileString(ship.receipts).pipe(
                  Effect.mapError(
                    () =>
                      new FleetError({
                        reason: "Ship receipt history unavailable",
                      })
                  )
                )
              : Effect.fail(
                  new FleetError({ reason: "Ship receipt history missing" })
                )
          ),
          Effect.flatMap((text) =>
            Effect.forEach(text.trim().split("\n").filter(Boolean), (line) =>
              Schema.decodeEffect(Schema.fromJsonString(ShipReceipt))(line)
            )
          ),
          Effect.option
        ),
        sessionsBackup:
          config.alarm.sessionsBackup === undefined
            ? Effect.succeed("off" as const)
            : collectSessionsBackup(config.alarm.sessionsBackup),
        windows: probe(windows),
      },
      { concurrency: "unbounded" }
    );

    const wakes = yield* wakeHealth(observations.readers.targets);

    const healthy = Option.getOrNull(observations.health);

    const failed = [
      ...unavailable({
        deploy: observations.deploy,
        digest: observations.digest,
        doctor: observations.doctor,
        health: observations.health,
        quarantine: observations.quarantine,
        receipts: observations.receipts,
      }),
      ...observations.readers.failed,
    ];

    return yield* Schema.decodeUnknownEffect(AlarmFacts)({
      backup: backupWindowOf(healthy),
      cacheBreaches: Option.getOrNull(observations.cache),
      ...(ship.restart.churnLimit === undefined
        ? undefined
        : { churnLimit: ship.restart.churnLimit }),
      deploy: Option.getOrNull(observations.deploy),
      deployKnown: Option.isSome(observations.deploy),
      digest: Option.getOrNull(observations.digest)?.status ?? null,
      doctor: Option.getOrNull(observations.doctor)?.status === "ok",
      doctorFinished: Option.isSome(observations.doctor),
      doctorReasons: Option.match(observations.doctor, {
        onNone: () => ["config doctor did not finish within 30 seconds"],
        onSome: (result) => result.reasons,
      }),
      entered:
        healthy?.services.celld?.activeEnterTimestamp === undefined ||
        healthy.services.celld.activeEnterTimestamp === null
          ? null
          : DateTime.toEpochMillis(healthy.services.celld.activeEnterTimestamp),
      failed,
      health: healthy?.health.status ?? null,
      instances: observations.instances,
      measurementFailed: failed.length > 0,
      quarantinedHour: Option.getOrNull(observations.quarantine),
      readers: observations.readers.facts,
      recallCanary: observations.recallCanary,
      receipts: Option.getOrElse(observations.receipts, () => []),
      receiptsKnown: Option.isSome(observations.receipts),
      sessionsBackup: observations.sessionsBackup,
      slots: healthy?.storage.slots ?? null,
      wakes,
      windows: Option.getOrElse(observations.windows, () => []),
    }).pipe(
      Effect.mapError(
        () => new FleetError({ reason: "Alarm measurements unavailable" })
      )
    );
  }
);
