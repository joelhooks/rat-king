import { Cause, Clock, Effect, FileSystem, Schema } from "effect";

import { writePrivateJson } from "../../packages/ratking-client/src/directory.ts";
import type { HealthDigest } from "./health.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const Outcome = Schema.Literals([
  "ok",
  "Alarm measurements unavailable",
  "Alarm cycle timed out",
  "Alarm journal unavailable",
  "Alarm notifications unavailable",
  "Alarm operation unavailable",
]);

export const AlarmHeartbeat = Schema.Struct({
  at: Schema.Finite,
  consecutiveFailures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: Outcome,
});

interface AlarmCycleFailure {
  readonly _tag: string;
}

export const alarmFailure = (
  failure: AlarmCycleFailure
): typeof Outcome.Type => {
  if (Schema.is(FleetError)(failure)) {
    if (failure.reason === "Alarm measurements unavailable") {
      return failure.reason;
    }

    if (failure.reason.toLowerCase().includes("journal")) {
      return "Alarm journal unavailable";
    }
  }

  return Cause.isTimeoutError(failure)
    ? "Alarm cycle timed out"
    : "Alarm operation unavailable";
};

export const nextAlarmHeartbeat = (
  previous: typeof AlarmHeartbeat.Type | null,
  at: number,
  outcome: typeof Outcome.Type
): typeof AlarmHeartbeat.Type => ({
  at,
  consecutiveFailures:
    outcome === "ok" ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
  outcome,
});

export const readAlarmHeartbeat = Effect.fn("Alarm.readHeartbeat")(
  function* readAlarmHeartbeat(directory: string) {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(`${directory}/alarm-heartbeat.json`).pipe(
      Effect.flatMap(
        Schema.decodeEffect(Schema.fromJsonString(AlarmHeartbeat))
      ),
      Effect.orElseSucceed(() => null)
    );
  }
);

export const writeAlarmHeartbeat = Effect.fn("Alarm.writeHeartbeat")(
  function* writeAlarmHeartbeat(
    directory: string,
    heartbeat: typeof AlarmHeartbeat.Type
  ) {
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(AlarmHeartbeat)
    )(heartbeat);

    yield* writePrivateJson(`${directory}/alarm-heartbeat.json`, json);
  }
);

export const alarmHeartbeatFailure = (
  heartbeat: typeof AlarmHeartbeat.Type | null,
  now: number
): string | null => {
  if (heartbeat === null) {
    return "alarm worker: heartbeat missing or unreadable";
  }

  if (heartbeat.at > now) {
    return "alarm worker: heartbeat clock invalid";
  }

  if (now - heartbeat.at > 300_000) {
    return "alarm worker: heartbeat older than 5 minutes";
  }

  if (heartbeat.consecutiveFailures >= 5) {
    return `alarm worker: ${heartbeat.consecutiveFailures} cycles failed in a row (${heartbeat.outcome})`;
  }

  return null;
};

export const withAlarmHeartbeat = Effect.fn("Alarm.digestHeartbeat")(
  function* withAlarmHeartbeat(config: StageConfigValue, digest: HealthDigest) {
    if (config.alarm?.enabled !== true) {
      return digest;
    }

    const reason = alarmHeartbeatFailure(
      yield* readAlarmHeartbeat(config.runtime.RAT_KING_STATE_DIR),
      yield* Clock.currentTimeMillis
    );

    return reason === null
      ? digest
      : {
          ...digest,
          reasons: [...digest.reasons, reason],
          status: "fail" as const,
        };
  }
);
