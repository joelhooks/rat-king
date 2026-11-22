import { Schema } from "effect";

import type {
  RestartEvent,
  RestartObservation,
  ShipReceipt,
} from "./ship-config.ts";

const Micros = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProcessStart = Schema.Struct({
  active: Schema.Boolean,
  enteredMicros: Micros,
  exitedMicros: Micros,
  pid: Micros,
});

export const observeRestart = (
  before: typeof ProcessStart.Type | null,
  after: typeof ProcessStart.Type | null
): typeof RestartObservation.Type => {
  if (
    before === null ||
    after === null ||
    !after.active ||
    after.pid === 0 ||
    after.enteredMicros === 0
  ) {
    return { durationSeconds: null, restarted: null };
  }

  const restarted =
    before.enteredMicros !== after.enteredMicros || before.pid !== after.pid;

  if (!restarted) {
    return { durationSeconds: 0, restarted };
  }

  const durationSeconds =
    after.exitedMicros > 0 && after.enteredMicros >= after.exitedMicros
      ? (after.enteredMicros - after.exitedMicros) / 1_000_000
      : null;

  return { durationSeconds, restarted };
};

export const observedRestartEvent = (
  events: readonly (typeof RestartEvent.Type)[],
  before: typeof ProcessStart.Type | null,
  after: typeof ProcessStart.Type | null
): typeof RestartEvent.Type => {
  const last = events.at(-1);

  const event = {
    durationSeconds: 0,
    observation: observeRestart(before, after),
    phase:
      last?.phase === "deferred"
        ? ("deferred" as const)
        : ("completed" as const),
    restarted: null,
  };

  return last?.retryAt === undefined
    ? event
    : { ...event, retryAt: last.retryAt };
};

export const restartOutcome = (
  events: readonly (typeof RestartEvent.Type)[]
): Pick<typeof ShipReceipt.Type, "celldRestarted" | "restartSeconds"> => {
  const observed = events.findLast(
    (event) => event.observation !== undefined
  )?.observation;

  if (observed !== undefined) {
    return {
      celldRestarted: observed.restarted,
      restartSeconds: observed.durationSeconds,
    };
  }

  const last = events.at(-1);
  const restarted = events.some((event) => event.restarted === true);
  const uncertain = last === undefined || last.restarted === null;

  return {
    celldRestarted: restarted || !uncertain ? restarted : null,
    restartSeconds: uncertain
      ? null
      : events.reduce((duration, event) => duration + event.durationSeconds, 0),
  };
};

export const deployOutcome = (
  code: number,
  events: readonly (typeof RestartEvent.Type)[]
): Pick<
  typeof ShipReceipt.Type,
  "celldRestarted" | "restartSeconds" | "retryAt" | "override"
> & { readonly result: "success" | "failed" | "deferred" } => {
  const lastGate = events.at(-1);
  const deferral = events.findLast((event) => event.phase === "deferred");
  let result: "success" | "failed" | "deferred" = "failed";

  if (code === 0) {
    result = "success";
  } else if (deferral !== undefined) {
    result = "deferred";
  }

  const override = events.findLast(
    (event) => event.override !== undefined
  )?.override;

  const outcome = restartOutcome(events);

  const verdict =
    override === undefined
      ? { ...outcome, result }
      : { ...outcome, override, result };

  const retryAt = result === "deferred" ? deferral?.retryAt : lastGate?.retryAt;

  return retryAt === undefined ? verdict : { ...verdict, retryAt };
};
