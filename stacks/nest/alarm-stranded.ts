import type {
  AlarmKeyValue,
  AlarmReadingValue,
  AlarmStateValue,
} from "./alarm-config.ts";
import type { AlarmFacts } from "./alarm-sources.ts";
import { stalledWakes } from "./alarm-wakes.ts";
import type { WakeSighting, WakeTarget } from "./alarm-wakes.ts";

export const STRANDED_MAIL_MS = 4 * 60 * 60_000;

export const READER_EXISTENCE_MS = 24 * 60 * 60_000;

export const rememberMailTargets = (
  prior: readonly (typeof WakeTarget.Type)[],
  seen: readonly (typeof WakeSighting.Type)[] | null | undefined
) =>
  [
    ...new Map(
      [...prior, ...(seen ?? [])].map((item) => [
        item.name,
        { name: item.name, owner: item.owner },
      ])
    ).values(),
  ].filter((target) => {
    const item = seen?.find((value) => value.name === target.name);

    return (
      item?.health === null ||
      item?.health === undefined ||
      !item.health.complete ||
      item.health.oldestWake !== null
    );
  });

const waitingAge = (item: typeof WakeSighting.Type, now: number) => {
  const { health } = item;

  const oldest =
    health?.oldestWakeSinceAck === undefined
      ? health?.oldestWake
      : health.oldestWakeSinceAck;

  return oldest === null || oldest === undefined ? 0 : now - oldest.at;
};

const readerAlive = (item: typeof WakeSighting.Type) =>
  item.session !== undefined &&
  item.health?.lease !== null &&
  item.session !== item.health?.lease.holder
    ? undefined
    : item.alive;

export const recentlyExisted = (item: typeof WakeSighting.Type, now: number) =>
  readerAlive(item) === true ||
  (readerAlive(item) === false &&
    item.lastProgressAt !== undefined &&
    now - item.lastProgressAt >= 0 &&
    now - item.lastProgressAt < READER_EXISTENCE_MS);

export const quietMailNames = (
  seen: readonly (typeof WakeSighting.Type)[] | null | undefined,
  now: number
) =>
  new Set(
    (seen ?? []).flatMap((item) =>
      item.retired === true ||
      item.retired === null ||
      !recentlyExisted(item, now)
        ? [item.name]
        : []
    )
  );

export const strandedObservationExpired = (
  state: AlarmStateValue | undefined,
  facts: typeof AlarmFacts.Type,
  now: number
) =>
  (facts.wakes === null || facts.wakes === undefined) &&
  state?.value === "firing" &&
  now - state.context.lastSent >= READER_EXISTENCE_MS;

export const needsTurnHealth = (item: typeof WakeSighting.Type, now: number) =>
  waitingAge(item, now) > STRANDED_MAIL_MS &&
  readerAlive(item) === true &&
  item.retired === false &&
  recentlyExisted(item, now) &&
  item.health?.lease !== null;

export const strandedReading = (
  item: typeof WakeSighting.Type,
  now: number
): AlarmReadingValue => {
  const { health } = item;

  if (item.retired === true) {
    return { status: "ok" };
  }

  if (!recentlyExisted(item, now)) {
    return { status: "ok" };
  }

  if (health === null || item.retired === null) {
    return { status: "unknown" };
  }

  const age = waitingAge(item, now);

  if (age <= STRANDED_MAIL_MS) {
    return health.complete ? { status: "ok" } : { status: "unknown" };
  }

  const gone = readerAlive(item) === false;

  const inactive =
    readerAlive(item) === true &&
    item.lastTurnAt !== undefined &&
    now - item.lastTurnAt > STRANDED_MAIL_MS;

  if (gone || inactive) {
    return {
      evidence: `${item.name}: mail waiting ${Math.floor(age / 60_000)}m; ${gone ? "reader gone" : "no turn activity in 4h"}`,
      recipients: item.owner === null ? [] : [item.owner],
      severity: "warn",
      status: "firing",
    };
  }

  return readerAlive(item) === true ? { status: "ok" } : { status: "unknown" };
};

export const mailReadings = (
  seen: readonly (typeof WakeSighting.Type)[] | null | undefined,
  now: number
): Partial<Record<AlarmKeyValue, AlarmReadingValue>> => {
  const readings: Partial<Record<AlarmKeyValue, AlarmReadingValue>> = {};

  for (const item of seen ?? []) {
    readings[`mail.stranded/${item.name}`] = strandedReading(item, now);
    readings[`mail.owner/${item.name}`] =
      item.retired !== true &&
      item.retired !== null &&
      recentlyExisted(item, now) &&
      item.configured === true &&
      stalledWakes([item], now).length > 0
        ? {
            evidence: `${item.name}: configured mail wait exceeded`,
            recipients: item.owner === null ? [] : [item.owner],
            severity: "warn",
            status: "firing",
          }
        : { status: "ok" };
  }

  return readings;
};

export const abandonedMailLines = (
  seen: readonly (typeof WakeSighting.Type)[],
  now: number
) => {
  const ages = seen.flatMap((item) =>
    waitingAge(item, now) > 0 &&
    item.retired !== true &&
    (!recentlyExisted(item, now) || item.retired === null)
      ? [waitingAge(item, now)]
      : []
  );

  return ages.length === 0
    ? []
    : [
        `abandoned mailboxes: ${ages.length} (oldest ${Math.floor(Math.max(...ages) / 3_600_000)}h)`,
      ];
};

export const strandedMailLines = (
  seen: readonly (typeof WakeSighting.Type)[],
  now: number
) =>
  seen.flatMap((item) => {
    const reading = strandedReading(item, now);

    return reading.status === "firing"
      ? [`${reading.evidence} (warn; no phone page)`]
      : [];
  });

export const busyMailLines = (
  seen: readonly (typeof WakeSighting.Type)[],
  now: number
) =>
  seen.flatMap((item) =>
    item.retired !== true &&
    recentlyExisted(item, now) &&
    readerAlive(item) === true &&
    waitingAge(item, now) > 0 &&
    strandedReading(item, now).status !== "firing"
      ? [
          `${item.name}: mail waiting ${Math.floor(waitingAge(item, now) / 60_000)}m on a live reader (digest only)`,
        ]
      : []
  );
