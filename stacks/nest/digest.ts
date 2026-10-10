import { Clock, DateTime, Effect, FileSystem, Schema } from "effect";

import { collectComms } from "./comms.ts";
import type { CountsValue } from "./comms.ts";
import { configDoctor } from "./config-doctor.ts";
import { Digest, DigestJson } from "./health.ts";
import type { HealthDigest } from "./health.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const FailedHealth = Schema.Struct({
  reasons: Schema.Array(Schema.String),
  status: Schema.Literal("fail"),
});

export const FleetDigest = Schema.Struct({
  at: Schema.String,
  comms: Schema.Struct({
    fallbacks_24h: Schema.Int,
    lost_24h: Schema.Int,
    quarantined_24h: Schema.Int,
    raw_intercom_24h: Schema.Int,
    sent_24h: Schema.Int,
    unanswered_24h: Schema.optionalKey(Schema.Int),
  }),
  rat_king: Schema.Union([Digest, FailedHealth]),
  reasons: Schema.Array(Schema.String),
  status: Schema.Literals(["ok", "warn", "fail"]),
});

export const composeDigest = (
  health: HealthDigest | typeof FailedHealth.Type,
  local: CountsValue,
  remote: CountsValue,
  at: string,
  doctor?: {
    readonly reasons: readonly string[];
    readonly status: "ok" | "fail";
  }
) => {
  const { sent } = local;
  const { fallbacks } = local;
  const { lost } = local;
  const { quarantined } = local;
  const raw = local.raw + remote.raw;

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
    ...(raw > 0 ? [`${raw} raw intercom tool sends in 24h`] : []),
  ];

  let status: "ok" | "warn" | "fail" = "ok";

  if (health.status === "fail" || doctor?.status === "fail" || lost > 0) {
    status = "fail";
  } else if (
    health.status === "warn" ||
    fallbacks > 0 ||
    quarantined > 0 ||
    raw > 0
  ) {
    status = "warn";
  }

  return {
    at,
    comms: {
      fallbacks_24h: fallbacks,
      lost_24h: lost,
      quarantined_24h: quarantined,
      raw_intercom_24h: raw,
      sent_24h: sent,
      unanswered_24h: local.unanswered + remote.unanswered,
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
      secondary: collectComms(config.comms.remote, now - 86_400_000),
    },
    { concurrency: "unbounded" }
  );

export const digest = Effect.fn("Nest.digest")(function* digest<E>(
  config: StageConfigValue,
  health: (prior: string | undefined) => Effect.Effect<HealthDigest, E>
) {
  const fs = yield* FileSystem.FileSystem;
  const history = `${config.runtime.RAT_KING_STATE_DIR}/health.jsonl`;
  let prior: string | undefined;

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

      if ("observedAt" in previous.rat_king) {
        prior = yield* Schema.encodeEffect(DigestJson)(previous.rat_king);
      }
    }
  }

  const now = yield* Clock.currentTimeMillis;
  const counts = yield* commsCounts(config, now);

  const facts = yield* health(prior).pipe(
    Effect.catch(() =>
      Effect.succeed({
        reasons: ["health action produced no digest"],
        status: "fail",
      } satisfies typeof FailedHealth.Type)
    )
  );

  const line = composeDigest(
    facts,
    counts.primary,
    counts.secondary,
    DateTime.formatIso(DateTime.makeUnsafe(now)).replace(/\.\d{3}Z$/u, "Z"),
    yield* configDoctor(config)
  );

  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(FleetDigest)
  )(line);

  yield* fs.writeFileString(history, `${encoded}\n`, {
    flag: "a",
    mode: 0o600,
  });

  return encoded;
});
