import { Clock, Console, DateTime, Effect, FileSystem, Schema } from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { readAlarmJournal } from "./alarm-journal.ts";
import type { SourceState } from "./alarm-sources.ts";
import { collectComms, doneBar } from "./comms.ts";
import type { CountsValue } from "./comms.ts";
import { configDoctor } from "./config-doctor.ts";
import type { FailedHealth } from "./digest-config.ts";
import { FleetDigest } from "./digest-config.ts";
import { DigestJson, doctorUnavailableSummary } from "./health.ts";
import type { HealthDigest } from "./health.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

export { FleetDigest } from "./digest-config.ts";

export const digestMaintenanceReasons = (
  sources: typeof SourceState.Type,
  now: number
): readonly string[] => {
  const cover = sources.measurementMaintenance;

  return cover !== undefined &&
    cover !== null &&
    cover.at <= now &&
    now <= cover.until
    ? [cover.evidence]
    : [];
};

export const composeDigest = (
  health: HealthDigest | typeof FailedHealth.Type,
  local: CountsValue,
  at: string,
  doctor?: {
    readonly reasons: readonly string[];
    readonly status: "ok" | "warn" | "fail";
  }
) => {
  const { fallbacks, lost, quarantined, sent } = local;

  const reasons = [
    ...health.reasons,
    ...(doctor?.reasons ?? []),
    ...(lost > 0
      ? [`${lost} messages lost (network and fallback both failed) in 24h`]
      : []),
    ...(fallbacks > 0 ? [`${fallbacks} intercom fallbacks in 24h`] : []),
    ...(quarantined > 0
      ? [`${quarantined} quarantined deliveries in 24h`]
      : []),
  ];

  let status: "ok" | "warn" | "fail" = "ok";

  if (health.status === "fail" || doctor?.status === "fail" || lost > 0) {
    status = "fail";
  } else if (
    health.status === "warn" ||
    doctor?.status === "warn" ||
    fallbacks > 0 ||
    quarantined > 0
  ) {
    status = "warn";
  }

  return {
    at,
    comms: {
      fallbacks_24h: fallbacks,
      lost_24h: lost,
      quarantined_24h: quarantined,
      sent_24h: sent,
    },
    rat_king: health,
    reasons,
    status,
  };
};

export const commsCounts = (config: StageConfigValue, now: number) =>
  Effect.all(
    {
      primary: collectComms(config.comms.local, now - 86_400_000),
      secondary:
        config.comms.remote === undefined
          ? Effect.succeed(null)
          : collectComms(config.comms.remote, now - 86_400_000),
    },
    { concurrency: "unbounded" }
  );

export const doneBarCommand = Effect.fn("Nest.doneBar")(
  function* doneBarCommand(config: StageConfigValue) {
    const { primary, secondary } = yield* commsCounts(
      config,
      yield* Clock.currentTimeMillis
    );

    const passed = doneBar(primary, secondary);

    yield* Console.log(
      JSON.stringify({ local: primary, passed, remote: secondary })
    );

    if (!passed) {
      return yield* refuse("Done-bar not met");
    }

    return yield* Effect.void;
  }
);

export const digest = Effect.fn("Nest.digest")(function* digest<E, R = never>(
  config: StageConfigValue,
  health: (prior: string | undefined) => Effect.Effect<HealthDigest, E>,
  waitingMail: Effect.Effect<readonly string[], never, R> = Effect.succeed([])
) {
  const fs = yield* FileSystem.FileSystem;
  const history = `${config.runtime.RAT_KING_STATE_DIR}/health.jsonl`;
  let prior: string | undefined;
  let previousDoctorCount = 0;

  if (yield* fs.exists(history)) {
    const lines = (yield* fs.readFileString(history)).trim().split("\n");
    const last = lines.at(-1);

    if (last !== undefined && last !== "") {
      const previous = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(FleetDigest)
      )(last).pipe(
        Effect.mapError(
          () => new FleetError({ reason: "Invalid digest history" })
        )
      );

      previousDoctorCount = previous.doctorUnavailableCount ?? 0;

      if ("observedAt" in previous.rat_king) {
        prior = yield* Schema.encodeEffect(DigestJson)(previous.rat_king);
      }
    }
  }

  const now = yield* Clock.currentTimeMillis;
  const { primary } = yield* commsCounts(config, now);

  const facts = yield* health(prior).pipe(
    Effect.catch(() =>
      Effect.succeed({
        reasons: ["health action produced no digest"],
        status: "fail",
      } satisfies typeof FailedHealth.Type)
    )
  );

  const composed = composeDigest(
    facts,
    primary,
    DateTime.formatIso(DateTime.makeUnsafe(now)).replace(/\.\d{3}Z$/u, "Z"),
    yield* configDoctor(config)
  );

  const mail = yield* waitingMail;
  const journal = yield* readAlarmJournal(config.runtime.RAT_KING_STATE_DIR);
  const doctorCount = journal.sources.doctorUnavailableCount ?? 0;

  const doctorSummary = doctorUnavailableSummary(
    doctorCount,
    previousDoctorCount,
    journal.sources.doctorUnavailableReason
  );

  const line = {
    ...composed,
    doctorUnavailableCount: doctorCount,
    reasons: [
      ...composed.reasons,
      ...doctorSummary,
      ...digestMaintenanceReasons(journal.sources, now),
      ...mail,
    ],
    waitingMail: mail,
  };

  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(FleetDigest)
  )(line);

  yield* fs.writeFileString(history, `${encoded}\n`, {
    flag: "a",
    mode: 0o600,
  });

  return encoded;
});
