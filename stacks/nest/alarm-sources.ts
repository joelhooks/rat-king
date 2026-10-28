import { DateTime, Schema } from "effect";

import { readerVerdict } from "../../packages/ratking-client/src/reader-health.ts";
import type { ReaderHeartbeatValue } from "../../packages/ratking-client/src/reader-health.ts";
import { SessionsBackupFact, sessionsBackupReading } from "./alarm-backups.ts";
import { AlarmKey, AlarmReading } from "./alarm-config.ts";
import type { AlarmReadingValue } from "./alarm-config.ts";
import { RecallCanaryFact, recallCanaryReading } from "./alarm-recall.ts";
import {
  WakeSighting,
  WakeTarget,
  wakeReading,
  rememberWakeTargets,
} from "./alarm-wakes.ts";
import { Sha, ShipReceipt } from "./ship-config.ts";
import { sanitizeCandidateStderr } from "./ship-diagnostics.ts";
import { StopMemory, stopMemoryWarnings } from "./stop-memory.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DeployMarker = Schema.Struct({
  phase: Schema.Literals(["restarting", "done"]),
  sha: Schema.optionalKey(Sha),
  started: Schema.Finite,
});

export const CacheBreach = Schema.Struct({
  fullRewrites: Count,
  host: Schema.String,
  hour: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  session: Schema.String,
});

export const ReaderSighting = Schema.Struct({
  host: Schema.String,
  idleSeconds: Count,
  lastError: Schema.NullOr(Schema.String),
  name: Schema.String,
  owner: Schema.NullOr(Schema.String),
  state: Schema.String,
  verdict: Schema.Literals(["running", "stuck"]),
});

export type ReaderSightingValue = typeof ReaderSighting.Type;

export const sightReaders = (
  host: string,
  beats: readonly {
    readonly alive: boolean;
    readonly beat: ReaderHeartbeatValue;
  }[],
  now: number
): ReaderSightingValue[] =>
  beats.flatMap(({ alive, beat }) => {
    const verdict = readerVerdict(beat, alive, now);

    if (verdict === "stale") {
      return [];
    }

    const progress = DateTime.toEpochMillis(
      beat.lastConsumeOk ?? beat.startedAt
    );

    return [
      {
        host,
        idleSeconds: Math.max(0, Math.floor((now - progress) / 1000)),
        lastError: beat.lastError,
        name: beat.name,
        owner: beat.owner ?? null,
        state: beat.state,
        verdict,
      },
    ];
  });

export const InstanceHealth = Schema.Union([
  Schema.Struct({
    name: Schema.NonEmptyString,
    page: Schema.optionalKey(Schema.Boolean),
    status: Schema.Literal("ok"),
  }),
  Schema.Struct({
    name: Schema.NonEmptyString,
    page: Schema.optionalKey(Schema.Boolean),
    reason: Schema.NonEmptyString,
    status: Schema.Literal("down"),
  }),
]);

export const BackupWindow = Schema.Struct({
  end: Schema.NullOr(Schema.Finite),
  start: Schema.Finite,
});

const CelldSighting = Schema.Struct({
  entered: Schema.String,
  pid: Count,
});

export const WindowReceipt = Schema.Struct({
  approval: Schema.NonEmptyString,
  celldAfter: Schema.NullOr(CelldSighting),
  celldBefore: CelldSighting,
  end: Schema.Number,
  kind: Schema.Literal("window"),
  reason: Schema.NonEmptyString,
  result: Schema.Literals(["success", "failed"]),
  start: Schema.Number,
});

export const AlarmFacts = Schema.Struct({
  backup: Schema.optionalKey(Schema.NullOr(BackupWindow)),
  cacheBreaches: Schema.NullOr(Schema.Array(CacheBreach)),
  churnLimit: Schema.optionalKey(Schema.Int),
  deploy: Schema.NullOr(DeployMarker),
  deployKnown: Schema.Boolean,
  digest: Schema.NullOr(Schema.Literals(["ok", "warn", "fail"])),
  doctor: Schema.Boolean,
  doctorFinished: Schema.optionalKey(Schema.Boolean),
  doctorReasons: Schema.optionalKey(Schema.Array(Schema.String)),
  entered: Schema.NullOr(Schema.Finite),
  failed: Schema.optionalKey(Schema.Array(Schema.String)),
  health: Schema.NullOr(Schema.Int),
  instances: Schema.optionalKey(Schema.Array(InstanceHealth)),
  measurementFailed: Schema.Boolean,
  quarantinedHour: Schema.NullOr(Count),
  readers: Schema.NullOr(
    Schema.Struct({
      complete: Schema.Boolean,
      seen: Schema.Array(ReaderSighting),
    })
  ),
  recallCanary: Schema.optionalKey(
    Schema.Union([Schema.Literal("off"), Schema.NullOr(RecallCanaryFact)])
  ),
  receipts: Schema.Array(ShipReceipt),
  receiptsKnown: Schema.Boolean,
  sessionsBackup: Schema.optionalKey(
    Schema.Union([Schema.Literal("off"), Schema.NullOr(SessionsBackupFact)])
  ),
  slots: Schema.NullOr(Schema.Struct({ free: Count, max: Count })),
  stopMemory: Schema.optionalKey(Schema.NullOr(StopMemory)),
  wakes: Schema.optionalKey(Schema.NullOr(Schema.Array(WakeSighting))),
  windows: Schema.optionalKey(Schema.Array(WindowReceipt)),
});

export const SourceState = Schema.Struct({
  doctorMisses: Schema.optionalKey(Count),
  downChecks: Count,
  entered: Schema.NullOr(Schema.Finite),
  instanceDownChecks: Schema.optionalKey(Schema.Record(Schema.String, Count)),
  measurementMisses: Schema.optionalKey(Count),
  unexplained: Schema.Array(Schema.Finite),
  wakeTargets: Schema.optionalKey(Schema.Array(WakeTarget)),
});

export const emptySources: typeof SourceState.Type = {
  downChecks: 0,
  entered: null,
  unexplained: [],
  wakeTargets: [],
};

export const Readings = Schema.Record(AlarmKey, AlarmReading);

const ok: AlarmReadingValue = { status: "ok" };

const unknown: AlarmReadingValue = { status: "unknown" };

const firing = (
  severity: "warn" | "critical",
  evidence: string
): AlarmReadingValue => ({ evidence, severity, status: "firing" });

export const RESTART_MEMORY_MS = 3_600_000;

export const deployWindow = (facts: typeof AlarmFacts.Type, now: number) => {
  const { deploy } = facts;

  return (
    deploy?.phase === "restarting" &&
    now >= deploy.started * 1000 &&
    now - deploy.started * 1000 < 180_000 &&
    !facts.receipts.some(
      (receipt) => receipt.sha === deploy.sha && receipt.end >= deploy.started
    )
  );
};

const trackSources = (
  prior: typeof SourceState.Type,
  facts: typeof AlarmFacts.Type,
  now: number
): typeof SourceState.Type => {
  const explains = (instant: number) =>
    facts.receipts.some(
      (receipt) =>
        receipt.start * 1000 <= instant && receipt.end * 1000 >= instant
    ) ||
    (facts.windows ?? []).some(
      (window) => window.start * 1000 <= instant && window.end * 1000 >= instant
    ) ||
    (facts.backup !== undefined &&
      facts.backup !== null &&
      facts.backup.start <= instant &&
      (facts.backup.end ?? now) >= instant);

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

  const base = {
    downChecks:
      !facts.deployKnown || deployWindow(facts, now) || facts.health === 200
        ? 0
        : Math.min(prior.downChecks + 1, 2),
    entered: facts.entered ?? prior.entered,
    unexplained,
  };

  const measured: typeof SourceState.Type = facts.measurementFailed
    ? {
        ...base,
        measurementMisses: Math.min((prior.measurementMisses ?? 0) + 1, 2),
      }
    : base;

  const tracked: typeof SourceState.Type = facts.doctor
    ? measured
    : {
        ...measured,
        doctorMisses: Math.min((prior.doctorMisses ?? 0) + 1, 2),
      };

  return facts.instances === undefined || facts.instances.length === 0
    ? tracked
    : {
        ...tracked,
        instanceDownChecks: Object.fromEntries(
          facts.instances.map((instance) => [
            instance.name,
            instance.status === "down"
              ? Math.min(
                  (prior.instanceDownChecks?.[instance.name] ?? 0) + 1,
                  2
                )
              : 0,
          ])
        ),
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

export const DEFAULT_CHURN_LIMIT = 3;

const shipChurnReading = (
  facts: typeof AlarmFacts.Type,
  now: number
): AlarmReadingValue => {
  if (!facts.receiptsKnown) {
    return unknown;
  }

  const limit = facts.churnLimit ?? DEFAULT_CHURN_LIMIT;

  const restarts = facts.receipts.filter(
    (receipt) =>
      receipt.celldRestarted === true &&
      now - receipt.end * 1000 < 86_400_000 &&
      receipt.end * 1000 <= now
  ).length;

  return restarts > limit
    ? firing(
        "warn",
        `${restarts} ship restarts in 24h, limit ${limit}; restarts are not blocked`
      )
    : ok;
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

const readerReading = (facts: typeof AlarmFacts.Type): AlarmReadingValue => {
  if (facts.readers === null) {
    return unknown;
  }

  const stuck = facts.readers.seen.filter(
    (reader) => reader.verdict === "stuck"
  );

  if (stuck.length > 0) {
    const owners = stuck.flatMap((reader) =>
      reader.owner === null ? [] : [reader.owner]
    );

    return {
      evidence: `${stuck.length} live Pi readers made no lease or consume progress for over 5 minutes: ${stuck
        .map(
          (reader) =>
            `${reader.name} on ${reader.host} ${reader.state}${reader.lastError === null ? "" : ` (${reader.lastError})`} idle ${Math.floor(reader.idleSeconds / 60)}m`
        )
        .join("; ")}`,
      recipients: [...new Set(owners)],
      severity: "warn",
      status: "firing",
    };
  }

  return facts.readers.complete ? ok : unknown;
};

const instanceReading = (
  facts: typeof AlarmFacts.Type,
  sources: typeof SourceState.Type
): AlarmReadingValue => {
  const down = (facts.instances ?? []).filter(
    (instance) => instance.status === "down"
  );

  const pages = down.some(
    (instance) =>
      instance.page === true &&
      (sources.instanceDownChecks?.[instance.name] ?? 0) >= 2
  );

  return down.length === 0
    ? ok
    : firing(
        pages ? "critical" : "warn",
        down
          .map((instance) => `${instance.name}: ${instance.reason}`)
          .join("; ")
      );
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
        `${sources.unexplained.length} observed process starts lack an explaining ship receipt or backup run`
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

const digestEvidence = (facts: typeof AlarmFacts.Type) => {
  const failed = facts.failed ?? [];

  const named =
    failed.length > 0
      ? `Measurements unavailable: ${failed.join(", ")}`
      : "An alarm measurement was unavailable";

  if (facts.digest !== "fail") {
    return named;
  }

  return facts.measurementFailed
    ? `Fleet digest failed; ${named}`
    : "Fleet digest failed";
};

const doctorReading = (
  facts: typeof AlarmFacts.Type,
  sources: typeof SourceState.Type
): AlarmReadingValue => {
  if (facts.doctor) {
    return ok;
  }

  if ((sources.doctorMisses ?? 0) < 2) {
    return unknown;
  }

  const named = (facts.doctorReasons ?? []).join("; ");

  if (facts.doctorFinished === false) {
    return firing(
      "warn",
      `Configuration doctor did not report twice in a row, so identity was not checked; the alarm host may be overloaded: ${named}`
    );
  }

  return firing(
    "critical",
    named === ""
      ? "Configuration doctor failed twice in a row; it gave no reason"
      : `Configuration doctor failed twice in a row: ${named}`
  );
};

const digestReading = (
  facts: typeof AlarmFacts.Type,
  sources: typeof SourceState.Type
): AlarmReadingValue => {
  const memory =
    facts.stopMemory === null || facts.stopMemory === undefined
      ? []
      : stopMemoryWarnings(facts.stopMemory);

  const digestFailed =
    facts.digest === "fail" ||
    (facts.measurementFailed && (sources.measurementMisses ?? 0) >= 2);

  if (memory.length > 0 || digestFailed) {
    return firing(
      "warn",
      [...(digestFailed ? [digestEvidence(facts)] : []), ...memory].join("; ")
    );
  }

  if (facts.measurementFailed) {
    return unknown;
  }

  return facts.digest === null ? unknown : ok;
};

export const observeAlarms = (
  prior: typeof SourceState.Type,
  facts: typeof AlarmFacts.Type,
  now: number
) => {
  const wake = wakeReading(
    facts.wakes,
    now,
    (prior.wakeTargets ?? []).map((item) => item.name)
  );

  const sources = {
    ...trackSources(prior, facts, now),
    wakeTargets: rememberWakeTargets(
      prior.wakeTargets ?? [],
      facts.wakes,
      wake,
      now
    ),
  };

  const readings: typeof Readings.Type = {
    "backup.sessions-index": sessionsBackupReading(facts.sessionsBackup, now),
    "cache.rewrites": cacheReading(facts, now),
    "celld.down": downReading(facts, sources, now),
    "celld.restarted": restartReading(facts, sources, now),
    "digest.fail": digestReading(facts, sources),
    "filer.slots": slotReading(facts),
    "instance.down": instanceReading(facts, sources),
    "issuer.broken": doctorReading(facts, sources),
    "quarantine.growth": quarantineReading(facts),
    "readers.stuck": readerReading(facts),
    "recall.flowing-canary": recallCanaryReading(facts.recallCanary),
    "ship.churn": shipChurnReading(facts, now),
    "ship.failed": shipReading(facts),
    "wake.unacked": wake,
  };

  return { readings, sources };
};
