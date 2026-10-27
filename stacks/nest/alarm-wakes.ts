import { Schema } from "effect";

import {
  healthVerdict,
  MailboxHealth,
  WAKE_UNACKED_MS,
} from "../../packages/mailbox-client/src/health.ts";
import { ConfiguredWakeTarget } from "./alarm-config.ts";
import type { AlarmReadingValue } from "./alarm-config.ts";

export const WakeTarget = Schema.Struct({
  configured: Schema.optionalKey(Schema.Literal(true)),
  name: Schema.String,
  owner: Schema.NullOr(Schema.String),
  page: ConfiguredWakeTarget.fields.page,
  unackedMinutes: ConfiguredWakeTarget.fields.unackedMinutes,
});

export const mergeWakeTargets = (
  readers?: readonly (typeof WakeTarget.Type)[],
  configured: readonly (typeof ConfiguredWakeTarget.Type)[] = []
): readonly (typeof WakeTarget.Type)[] | undefined =>
  readers === undefined && configured.length === 0
    ? undefined
    : [
        ...new Map(
          [
            ...(readers ?? []),
            ...configured.map((target) => ({
              ...target,
              configured: true as const,
            })),
          ].map((target) => [target.name, target])
        ).values(),
      ];

export const WakeSighting = Schema.Struct({
  ...WakeTarget.fields,
  health: Schema.NullOr(MailboxHealth),
});

export const stalledWakes = (
  seen: readonly (typeof WakeSighting.Type)[],
  now: number
) =>
  seen.filter(
    (item) =>
      item.health !== null &&
      (item.configured === true
        ? item.health.oldestWake !== null &&
          now - item.health.oldestWake.at >
            (item.unackedMinutes === undefined
              ? WAKE_UNACKED_MS
              : item.unackedMinutes * 60_000)
        : healthVerdict({ ...item.health, reader: "unknown" }, now) ===
          "agent not taking turns")
  );

export const newWakeTargets = (
  prior: readonly (typeof WakeTarget.Type)[],
  seen: readonly (typeof WakeSighting.Type)[],
  now: number
) =>
  stalledWakes(seen, now).some(
    (item) => !prior.some((target) => target.name === item.name)
  );

export const rememberWakeTargets = (
  prior: readonly (typeof WakeTarget.Type)[],
  seen: readonly (typeof WakeSighting.Type)[] | null | undefined,
  reading: AlarmReadingValue,
  now: number
) =>
  reading.status === "ok"
    ? []
    : [
        ...new Map(
          [...prior, ...stalledWakes(seen ?? [], now)].map((item) => [
            item.name,
            { name: item.name, owner: item.owner },
          ])
        ).values(),
      ];

export const wakeReading = (
  seen: readonly (typeof WakeSighting.Type)[] | null | undefined,
  now: number,
  expected: readonly string[] = []
): AlarmReadingValue => {
  if (seen === null || seen === undefined) {
    return { status: "unknown" };
  }

  const stalled = stalledWakes(seen, now);

  if (stalled.length > 0) {
    return {
      evidence: stalled
        .map((item) => {
          const lease = item.health?.lease;

          const age = Math.floor(
            (now - (item.health?.oldestWake?.at ?? now)) / 1000
          );

          if (lease === null || lease === undefined) {
            return `${item.name}: reader gone, mail waiting ${age}s, lease missing`;
          }

          return lease.expiresAt <= now
            ? `${item.name}: reader gone, mail waiting ${age}s, lease expired`
            : `${item.name}: mail waiting ${age}s, live lease`;
        })
        .join("; "),
      recipients: [
        ...new Set(
          stalled.flatMap((item) => (item.owner === null ? [] : [item.owner]))
        ),
      ],
      severity: "warn",
      status: "firing",
    };
  }

  if (expected.some((name) => !seen.some((item) => item.name === name))) {
    return { status: "unknown" };
  }

  return seen.some(
    (item) =>
      item.health === null ||
      !item.health.complete ||
      (item.configured !== true &&
        item.health.oldestWake !== null &&
        (item.health.lease === null || item.health.lease.expiresAt <= now))
  )
    ? { status: "unknown" }
    : { status: "ok" };
};
