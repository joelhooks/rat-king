import { Schema } from "effect";

import { MailboxHealth } from "../../packages/mailbox-client/src/health.ts";
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
  defaultUnackedMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0))
  ),
  health: Schema.NullOr(MailboxHealth),
});

export const DEFAULT_WAKE_UNACKED_MINUTES = 15;

export const WAKE_CRITICAL_MS = 30 * 60_000;

const wakeLimit = (item: typeof WakeSighting.Type) =>
  (item.configured === true && item.unackedMinutes !== undefined
    ? item.unackedMinutes
    : (item.defaultUnackedMinutes ?? DEFAULT_WAKE_UNACKED_MINUTES)) * 60_000;

const waiting = (health: NonNullable<typeof WakeSighting.Type.health>) =>
  health.oldestWakeSinceAck === undefined
    ? health.oldestWake
    : health.oldestWakeSinceAck;

const overdue = (item: typeof WakeSighting.Type, now: number) => {
  const oldest = item.health === null ? null : waiting(item.health);

  return oldest !== null && now - oldest.at > wakeLimit(item);
};

const progressing = (item: typeof WakeSighting.Type, now: number) => {
  const lastAck = item.health?.lastAck ?? null;
  const oldest = item.health?.oldestWake ?? null;

  return (
    item.health?.oldestWakeSinceAck === undefined &&
    lastAck !== null &&
    oldest !== null &&
    lastAck >= oldest.at &&
    now - lastAck <= wakeLimit(item)
  );
};

const agedOut = (item: typeof WakeSighting.Type, now: number) => {
  const oldest = item.health?.oldestWake ?? null;

  return oldest !== null && now - oldest.at > wakeLimit(item);
};

export const staleSingleWakes = (
  seen: readonly (typeof WakeSighting.Type)[],
  now: number
) =>
  seen.filter(
    (item) =>
      agedOut(item, now) &&
      (item.health?.oldestWakeSinceAck === undefined
        ? progressing(item, now)
        : !overdue(item, now))
  );

export const stalledWakes = (
  seen: readonly (typeof WakeSighting.Type)[],
  now: number
) =>
  seen.filter(
    (item) =>
      item.health !== null &&
      !progressing(item, now) &&
      (item.configured === true
        ? overdue(item, now)
        : item.health.lease !== null &&
          item.health.lease.expiresAt > now &&
          overdue(item, now))
  );

const waitedMs = (item: typeof WakeSighting.Type, now: number) => {
  const oldest = item.health === null ? null : waiting(item.health);

  return oldest === null ? 0 : now - oldest.at;
};

export const pagingWake = (item: typeof WakeSighting.Type) =>
  item.name === "switchboard" || item.page === true;

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
  const singles = staleSingleWakes(seen, now).length;

  if (stalled.length > 0) {
    return {
      evidence: [
        ...stalled.map((item) => {
          const lease = item.health?.lease;

          const age = Math.floor(
            (now -
              ((item.health === null ? null : waiting(item.health))?.at ??
                now)) /
              1000
          );

          if (lease === null || lease === undefined) {
            return `${item.name}: reader gone, mail waiting ${age}s, lease missing`;
          }

          return lease.expiresAt <= now
            ? `${item.name}: reader gone, mail waiting ${age}s, lease expired`
            : `${item.name}: mail waiting ${age}s, live lease`;
        }),
        ...(singles === 0
          ? []
          : [`info: ${singles} stale single message(s) on acking readers`]),
      ].join("; "),
      recipients: [
        ...new Set(
          stalled.flatMap((item) => (item.owner === null ? [] : [item.owner]))
        ),
      ],
      severity: stalled.some(
        (item) => pagingWake(item) && waitedMs(item, now) > WAKE_CRITICAL_MS
      )
        ? "critical"
        : "warn",
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
