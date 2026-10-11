import { Schema } from "effect";

import { AlarmKey, AlarmReading } from "./alarm-config.ts";
import type { AlarmReadingValue } from "./alarm-config.ts";
import { ShipReceipt } from "./ship-config.ts";
import { sanitizeCandidateStderr } from "./ship-diagnostics.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DeployMarker = Schema.Struct({
  phase: Schema.Literals(["restarting", "done"]),
  started: Schema.Finite,
});

export const CacheBreach = Schema.Struct({
  fullRewrites: Count,
  host: Schema.String,
  hour: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  session: Schema.String,
});

export const AlarmFacts = Schema.Struct({
  cacheBreaches: Schema.NullOr(Schema.Array(CacheBreach)),
  deploy: Schema.NullOr(
    Schema.Struct({
      phase: Schema.Literals(["restarting", "done"]),
      started: Schema.Finite,
    })
  ),
  deployKnown: Schema.Boolean,
  digest: Schema.NullOr(Schema.Literals(["ok", "warn", "fail"])),
  doctor: Schema.Boolean,
  entered: Schema.NullOr(Schema.Finite),
  health: Schema.NullOr(Schema.Int),
  measurementFailed: Schema.Boolean,
  quarantinedHour: Schema.NullOr(Count),
  readers: Schema.Record(
    Schema.String,
    Schema.Literals(["present", "missing", "inactive", "unknown"])
  ),
  receipts: Schema.Array(ShipReceipt),
  receiptsKnown: Schema.Boolean,
  slots: Schema.NullOr(Schema.Struct({ free: Count, max: Count })),
});

export const SourceState = Schema.Struct({
  downChecks: Count,
  entered: Schema.NullOr(Schema.Finite),
  missingReaders: Schema.Record(Schema.String, Schema.Finite),
  unexplained: Schema.Array(Schema.Finite),
});

export const emptySources: typeof SourceState.Type = {
  downChecks: 0,
  entered: null,
  missingReaders: {},
  unexplained: [],
};

export const Readings = Schema.Record(AlarmKey, AlarmReading);

const ok: AlarmReadingValue = { status: "ok" };

const unknown: AlarmReadingValue = { status: "unknown" };

const firing = (
  severity: "warn" | "critical",
  evidence: string
): AlarmReadingValue => ({ evidence, severity, status: "firing" });

export const RESTART_MEMORY_MS = 3_600_000;

export const deployWindow = (facts: typeof AlarmFacts.Type, now: number) =>
  facts.deploy?.phase === "restarting" &&
  now >= facts.deploy.started * 1000 &&
  now - facts.deploy.started * 1000 < 180_000;

const trackSources = (
  prior: typeof SourceState.Type,
  facts: typeof AlarmFacts.Type,
  now: number
): typeof SourceState.Type => {
  const explains = (instant: number) =>
    facts.receipts.some(
      (receipt) =>
        receipt.celldRestarted === true &&
        receipt.start * 1000 <= instant &&
        receipt.end * 1000 >= instant
    );

  const unexplained = prior.unexplained.filter(
    (instant) => !explains(instant) && now - instant < RESTART_MEMORY_MS
  );

  if (
    facts.entered !== null &&
    prior.entered !== null &&
    facts.entered > prior.entered &&
    !explains(facts.entered)
  ) {
    unexplained.push(facts.entered);
  }

  const missingReaders: Record<string, number> = {};

  for (const [name, status] of Object.entries(facts.readers)) {
    if (status === "missing") {
      missingReaders[name] = prior.missingReaders[name] ?? now;
    }
  }

  return {
    downChecks:
      !facts.deployKnown || deployWindow(facts, now) || facts.health === 200
        ? 0
        : Math.min(prior.downChecks + 1, 2),
    entered: facts.entered ?? prior.entered,
    missingReaders,
    unexplained,
  };
};

const shipReading = (facts: typeof AlarmFacts.Type): AlarmReadingValue => {
  if (!facts.receiptsKnown) {
    return unknown;
  }

  const receipt = facts.receipts.at(-1);

  if (receipt?.result !== "failed") {
    return ok;
  }

  return firing(
    "warn",
    `sha ${receipt.sha}; ${sanitizeCandidateStderr(receipt.stderrTail ?? "")}`
  );
};

const slotReading = (facts: typeof AlarmFacts.Type): AlarmReadingValue => {
  if (facts.slots === null || facts.slots.max === 0) {
    return unknown;
  }

  const ratio = facts.slots.free / facts.slots.max;

  if (ratio >= 0.1) {
    return ok;
  }

  return firing(
    ratio < 0.05 ? "critical" : "warn",
    `${facts.slots.free}/${facts.slots.max} free slots`
  );
};

const readerReading = (
  facts: typeof AlarmFacts.Type,
  sources: typeof SourceState.Type,
  now: number
): AlarmReadingValue => {
  if (Object.keys(facts.readers).length === 0) {
    return unknown;
  }

  const stuck = Object.values(sources.missingReaders).filter(
    (since) => now - since >= 600_000
  ).length;

  if (stuck > 0) {
    return firing(
      "warn",
      `${stuck} configured readers have no lease for at least 10 minutes with Pi alive`
    );
  }

  return Object.values(facts.readers).includes("unknown") ? unknown : ok;
};

const downReading = (
  facts: typeof AlarmFacts.Type,
  sources: typeof SourceState.Type,
  now: number
): AlarmReadingValue => {
  if (!facts.deployKnown || deployWindow(facts, now)) {
    return unknown;
  }

  if (sources.downChecks >= 2) {
    return firing(
      "critical",
      "Mailbox health was not 200 in two consecutive checks"
    );
  }

  return facts.health === 200 ? ok : unknown;
};

const restartReading = (
  facts: typeof AlarmFacts.Type,
  sources: typeof SourceState.Type,
  now: number
): AlarmReadingValue => {
  if (
    facts.entered === null ||
    !facts.receiptsKnown ||
    deployWindow(facts, now)
  ) {
    return unknown;
  }

  return sources.unexplained.length > 0
    ? firing(
        "warn",
        `${sources.unexplained.length} observed process starts lack an explaining ship receipt`
      )
    : ok;
};

const quarantineReading = (
  facts: typeof AlarmFacts.Type
): AlarmReadingValue => {
  if (facts.quarantinedHour === null) {
    return unknown;
  }

  return facts.quarantinedHour > 20
    ? firing(
        "warn",
        `${facts.quarantinedHour} new quarantine files in one hour`
      )
    : ok;
};

export const CACHE_PAGE_SESSIONS = 3;

const cacheReading = (
  facts: typeof AlarmFacts.Type,
  now: number
): AlarmReadingValue => {
  if (facts.cacheBreaches === null) {
    return unknown;
  }

  const current = facts.cacheBreaches.filter(
    (breach) => now - Date.parse(breach.hour) < 7_200_000
  );

  const sessions = [
    ...new Set(current.map((breach) => `${breach.host}/${breach.session}`)),
  ];

  if (sessions.length === 0) {
    return ok;
  }

  const worst = [
    ...new Map(
      current
        .toSorted((a, b) => a.fullRewrites - b.fullRewrites)
        .map((breach) => [`${breach.host}/${breach.session}`, breach] as const)
    ).values(),
  ]
    .toSorted((a, b) => b.fullRewrites - a.fullRewrites)
    .slice(0, 3)
    .map(
      (breach) =>
        `${breach.name ?? breach.session} on ${breach.host} ${breach.fullRewrites} rebuilds`
    )
    .join("; ");

  return firing(
    sessions.length >= CACHE_PAGE_SESSIONS ? "critical" : "warn",
    `${sessions.length} sessions did 10 or more full cache rebuilds in an hour: ${worst}`
  );
};

const digestReading = (facts: typeof AlarmFacts.Type): AlarmReadingValue => {
  if (facts.measurementFailed || facts.digest === "fail") {
    return firing(
      "warn",
      "Digest failed or an alarm measurement was unavailable"
    );
  }

  return facts.digest === null ? unknown : ok;
};

export const observeAlarms = (
  prior: typeof SourceState.Type,
  facts: typeof AlarmFacts.Type,
  now: number
) => {
  const sources = trackSources(prior, facts, now);

  const readings: typeof Readings.Type = {
    "cache.rewrites": cacheReading(facts, now),
    "celld.down": downReading(facts, sources, now),
    "celld.restarted": restartReading(facts, sources, now),
    "digest.fail": digestReading(facts),
    "filer.slots": slotReading(facts),
    "issuer.broken": facts.doctor
      ? ok
      : firing(
          "critical",
          "Configuration doctor failed; input values withheld"
        ),
    "quarantine.growth": quarantineReading(facts),
    "readers.stuck": readerReading(facts, sources, now),
    "ship.failed": shipReading(facts),
  };

  return { readings, sources };
};
