import {
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Result,
  Schema,
} from "effect";

import { prepareAlarmMail } from "./alarm-mail.ts";
import type { DeployMarker } from "./alarm-sources.ts";
import { AlarmFacts, CacheBreach } from "./alarm-sources.ts";
import { collectComms } from "./comms.ts";
import { configDoctor } from "./config-doctor.ts";
import { FleetDigest } from "./digest.ts";
import type { HealthDigest } from "./health.ts";
import { execute } from "./ship-command.ts";
import { ShipReceipt } from "./ship-config.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const Alive = Schema.Struct({ alive: Schema.Boolean });

type CacheBreachValue = typeof CacheBreach.Type;

const readerStatus = Effect.fn("Alarm.readerStatus")(function* readerStatus(
  config: StageConfigValue,
  name: string,
  command: readonly string[],
  now: number
) {
  const [program, ...args] = command;

  if (program === undefined) {
    return "unknown" as const;
  }

  const process = yield* execute(
    program,
    args,
    config.runtime.RAT_KING_STATE_DIR
  ).pipe(Effect.timeout("5 seconds"), Effect.option);

  if (Option.isNone(process) || process.value.code !== 0) {
    return "unknown" as const;
  }

  const alive = yield* Schema.decodeEffect(Schema.fromJsonString(Alive))(
    process.value.output
  ).pipe(Effect.option);

  if (Option.isNone(alive)) {
    return "unknown" as const;
  }

  if (!alive.value.alive) {
    return "inactive" as const;
  }

  const prepared = yield* prepareAlarmMail(config, [name], "");
  const target = prepared.targets.find((item) => item.name === name);

  if (target === undefined) {
    return "unknown" as const;
  }

  const lease = yield* prepared.client
    .resolveLease(target.did)
    .pipe(Effect.result);

  if (Result.isFailure(lease)) {
    return lease.failure.error === "LeaseNotFound"
      ? ("missing" as const)
      : ("unknown" as const);
  }

  const expires = yield* Schema.decodeEffect(Schema.DateTimeUtcFromString)(
    lease.success.expiresAt
  ).pipe(Effect.option);

  if (Option.isNone(expires)) {
    return "unknown" as const;
  }

  return DateTime.toEpochMillis(expires.value) > now
    ? ("present" as const)
    : ("missing" as const);
}, Effect.scoped);

const probe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout("30 seconds"),
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeed(Option.none<A>()))
  );

export const collectAlarmFacts = Effect.fn("Alarm.collect")(
  function* collectAlarmFacts<E, R, E2, R2>(
    config: StageConfigValue,
    health: Effect.Effect<HealthDigest, E, R>,
    deploy: Effect.Effect<typeof DeployMarker.Type | null, E2, R2>
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
        doctor: probe(configDoctor(config)),
        health: probe(health),
        quarantine: Effect.all(
          [
            collectComms(config.comms.local, now - 3_600_000, true),
            collectComms(config.comms.remote, now - 3_600_000, true),
          ],
          { concurrency: "unbounded" }
        ).pipe(
          Effect.map((counts) =>
            counts.reduce((total, count) => total + count.quarantined, 0)
          ),
          Effect.timeout("30 seconds"),
          Effect.option
        ),
        readers: Effect.forEach(
          config.alarm.readers,
          (reader) =>
            readerStatus(config, reader.name, reader.aliveCommand, now).pipe(
              Effect.catch(() => Effect.succeed("unknown" as const)),
              Effect.map((status) => [reader.name, status] as const)
            ),
          { concurrency: 4 }
        ).pipe(
          Effect.timeout("30 seconds"),
          Effect.catchCause(() =>
            Effect.succeed(
              config.alarm?.readers.map(
                (reader) => [reader.name, "unknown"] as const
              ) ?? []
            )
          )
        ),
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
      },
      { concurrency: "unbounded" }
    );

    const healthy = Option.getOrNull(observations.health);
    const readers = Object.fromEntries(observations.readers);

    return yield* Schema.decodeUnknownEffect(AlarmFacts)({
      cacheBreaches: Option.getOrNull(observations.cache),
      deploy: Option.getOrNull(observations.deploy),
      deployKnown: Option.isSome(observations.deploy),
      digest: Option.getOrNull(observations.digest)?.status ?? null,
      doctor: Option.getOrNull(observations.doctor)?.status === "ok",
      entered:
        healthy?.services.celld?.activeEnterTimestamp === undefined ||
        healthy.services.celld.activeEnterTimestamp === null
          ? null
          : DateTime.toEpochMillis(healthy.services.celld.activeEnterTimestamp),
      health: healthy?.health.status ?? null,
      measurementFailed:
        Option.isNone(observations.deploy) ||
        Option.isNone(observations.doctor) ||
        Option.isNone(observations.health) ||
        Option.isNone(observations.quarantine) ||
        Option.isNone(observations.digest) ||
        Option.isNone(observations.receipts) ||
        Object.values(readers).includes("unknown"),
      quarantinedHour: Option.getOrNull(observations.quarantine),
      readers,
      receipts: Option.getOrElse(observations.receipts, () => []),
      receiptsKnown: Option.isSome(observations.receipts),
      slots: healthy?.storage.slots ?? null,
    }).pipe(
      Effect.mapError(
        () => new FleetError({ reason: "Alarm measurements unavailable" })
      )
    );
  }
);
