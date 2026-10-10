import { Schema } from "effect";
import { setup, transition } from "xstate";

import { AlarmContext } from "./alarm-config.ts";
import type { AlarmReadingValue, AlarmStateValue } from "./alarm-config.ts";

const Empty = Schema.toStandardSchemaV1(Schema.Struct({ now: Schema.Finite }));

export const alarmMachine = setup({
  schemas: {
    context: Schema.toStandardSchemaV1(AlarmContext),
    events: {
      firing: Schema.toStandardSchemaV1(
        Schema.Struct({
          now: Schema.Finite,
          renotifyMs: Schema.Finite,
          severity: Schema.Literals(["warn", "critical"]),
        })
      ),
      ok: Empty,
    },
  },
}).createMachine({
  context: { lastSent: -1, severity: "warn", since: 0 },
  id: "alarm",
  initial: "ok",
  states: {
    firing: {
      on: {
        firing: ({ context, event }) => ({
          context: {
            ...context,
            lastSent:
              (event.severity === "critical" && context.severity === "warn") ||
              event.now - context.lastSent >= event.renotifyMs
                ? event.now
                : context.lastSent,
            severity: event.severity,
          },
          target: "firing",
        }),
        ok: { target: "recovered" },
      },
    },
    ok: {
      on: {
        firing: ({ event }) => ({
          context: {
            lastSent: event.now,
            severity: event.severity,
            since: event.now,
          },
          target: "firing",
        }),
      },
    },
    recovered: {
      on: {
        firing: ({ event }) => ({
          context: {
            lastSent: event.now,
            severity: event.severity,
            since: event.now,
          },
          target: "firing",
        }),
        ok: { target: "ok" },
      },
    },
  },
});

export const emptyAlarm: AlarmStateValue = {
  context: { lastSent: -1, severity: "warn", since: 0 },
  value: "ok",
};

export const advanceAlarm = (
  prior: AlarmStateValue,
  reading: AlarmReadingValue,
  now: number,
  renotifyMs: number
) => {
  if (reading.status === "unknown") {
    return { notice: "none" as const, state: prior };
  }

  const snapshot = alarmMachine.resolveState(prior);

  const [next] = transition(
    alarmMachine,
    snapshot,
    reading.status === "ok"
      ? { now, type: "ok" }
      : { now, renotifyMs, severity: reading.severity, type: "firing" }
  );

  const state: AlarmStateValue = { context: next.context, value: next.value };

  if (prior.value === "firing" && state.value === "recovered") {
    return { notice: "clear" as const, state };
  }

  return {
    notice:
      state.value === "firing" &&
      (prior.value !== "firing" ||
        state.context.lastSent !== prior.context.lastSent ||
        (prior.context.severity === "warn" &&
          state.context.severity === "critical"))
        ? ("fire" as const)
        : ("none" as const),
    state,
  };
};
