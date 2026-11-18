import { DateTime, Schema } from "effect";

import {
  READER_STUCK_MS,
  readerVerdict,
} from "../../packages/ratking-client/src/reader-health.ts";
import type { ReaderHeartbeatValue } from "../../packages/ratking-client/src/reader-health.ts";
import { SessionsBackupFact, sessionsBackupReading } from "./alarm-backups.ts";
import {
  AlarmKey,
  AlarmReading,
  DOCTOR_UNAVAILABLE_SPAN_MS,
  INSTANCE_DOWN_CHECKS,
  ISSUER_FAILURE_CHECKS,
  ISSUER_FAILURE_SPAN_MS,
} from "./alarm-config.ts";
import type { AlarmReadingValue } from "./alarm-config.ts";
import {
  MAILBOX_INSTANCE,
  MaintenanceWindow,
  backupCover,
  coveringWindow,
  coversOf,
  maintenanceEvidence,
  overranWindow,
  overrunEvidence,
} from "./alarm-maintenance.ts";
import type { Cover } from "./alarm-maintenance.ts";
import { readerRecovering } from "./alarm-reader-windows.ts";
import { RecallCanaryFact, recallCanaryReading } from "./alarm-recall.ts";
import { mailReadings, rememberMailTargets } from "./alarm-stranded.ts";
import { WakeSighting, WakeTarget } from "./alarm-wakes.ts";
import { Sha, ShipReceipt } from "./ship-config.ts";
import { sanitizeCandidateStderr } from "./ship-diagnostics.ts";
import { StopMemory, stopMemoryChecks } from "./stop-memory.ts";

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
  lastReason: Schema.optionalKey(Schema.String),
  name: Schema.String,
  owner: Schema.NullOr(Schema.String),
  session: Schema.optionalKey(Schema.String),
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
        ...(beat.lastReason === undefined
          ? undefined
          : { lastReason: beat.lastReason }),
        name: beat.name,
        owner: beat.owner ?? null,
        ...(beat.session === undefined ? undefined : { session: beat.session }),
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
  end: Schema.Finite,
  kind: Schema.Literal("window"),
  reason: Schema.NonEmptyString,
  result: Schema.Literals(["success", "failed"]),
  start: Schema.Finite,
});

export const AlarmFacts = Schema.Struct({
  backup: Schema.optionalKey(Schema.NullOr(BackupWindow)),
  cacheBreaches: Schema.NullOr(Schema.Array(CacheBreach)),
  churnLimit: Schema.optionalKey(Schema.Int),
  deploy: Schema.NullOr(DeployMarker),
  deployKnown: Schema.Boolean,
  deskWakes: Schema.optionalKey(Schema.NullOr(Schema.Array(WakeSighting))),
  digest: Schema.NullOr(Schema.Literals(["ok", "warn", "fail"])),
  doctor: Schema.Boolean,
  doctorFinished: Schema.optionalKey(Schema.Boolean),
  doctorReasons: Schema.optionalKey(Schema.Array(Schema.String)),
  entered: Schema.NullOr(Schema.Finite),
  failed: Schema.optionalKey(Schema.Array(Schema.String)),
  health: Schema.NullOr(Schema.Int),
  instances: Schema.optionalKey(Schema.Array(InstanceHealth)),
  maintenance: Schema.optionalKey(Schema.Array(MaintenanceWindow)),
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
  doctorFailureSince: Schema.optionalKey(Schema.Finite),
  doctorMisses: Schema.optionalKey(Count),
  doctorUnavailableCount: Schema.optionalKey(Count),
  doctorUnavailableReason: Schema.optionalKey(Schema.String),
  doctorUnavailableSince: Schema.optionalKey(Schema.Finite),
  downChecks: Count,
  entered: Schema.NullOr(Schema.Finite),
  instanceDownChecks: Schema.optionalKey(Schema.Record(Schema.String, Count)),
  lastUp: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  measurementMaintenance: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        at: Schema.Finite,
        evidence: Schema.String,
        until: Schema.Finite,
      })
    )
  ),
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

const trackDoctorAvailability = (
  prior: typeof SourceState.Type,
  facts: typeof AlarmFacts.Type,
  now: number
) => {
  if (facts.doctorFinished === false && !facts.doctor) {
    return {
      doctorUnavailableCount: (prior.doctorUnavailableCount ?? 0) + 1,
      doctorUnavailableReason:
        (facts.doctorReasons ?? []).join("; ") || "no reason reported",
      doctorUnavailableSince: prior.doctorUnavailableSince ?? now,
    };
  }

  return prior.doctorUnavailableCount === undefined
    ? {}
    : {
        doctorUnavailableCount: prior.doctorUnavailableCount,
        doctorUnavailableReason:
          prior.doctorUnavailableReason ?? "no reason reported",
      };
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
    coversOf(facts, MAILBOX_INSTANCE).some(
      (cover) => cover.start <= instant && cover.end >= instant
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

  const lastUp = {
    ...prior.lastUp,
    ...(facts.health === 200 ? { [MAILBOX_INSTANCE]: now } : undefined),
    ...Object.fromEntries(
      (facts.instances ?? [])
        .filter((instance) => instance.status === "ok")
        .map((instance) => [instance.name, now])
    ),
  };

  const watched = Object.fromEntries(
    Object.entries(lastUp).filter(
      ([instance]) => coversOf(facts, instance).length > 0
    )
  );

  const base = {
    ...trackDoctorAvailability(prior, facts, now),
    downChecks:
      !facts.deployKnown || deployWindow(facts, now) || facts.health === 200
        ? 0
        : Math.min(prior.downChecks + 1, 2),
    entered: facts.entered ?? prior.entered,
    ...(Object.keys(watched).length === 0 ? undefined : { lastUp: watched }),
    unexplained,
  };

  const measured: typeof SourceState.Type = facts.measurementFailed
    ? {
        ...base,
        measurementMisses: Math.min((prior.measurementMisses ?? 0) + 1, 2),
      }
    : base;

  const tracked: typeof SourceState.Type =
    facts.doctor || facts.doctorFinished === false
      ? measured
      : {
          ...measured,
          doctorFailureSince: prior.doctorFailureSince ?? now,
          doctorMisses: Math.min(
            (prior.doctorMisses ?? 0) + 1,
            ISSUER_FAILURE_CHECKS
          ),
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
                  INSTANCE_DOWN_CHECKS
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

const duplicateReader = (
  reader: ReaderSightingValue,
  facts: typeof AlarmFacts.Type,
  now: number
) =>
  reader.state === "SendOnly" &&
  reader.session !== undefined &&
  (facts.wakes ?? []).some((item) => {
    const lease = item.name === reader.name ? item.health?.lease : null;

    return (
      lease !== null &&
      lease !== undefined &&
      lease.expiresAt > now &&
      lease.holder !== reader.session
    );
  });

const readerReading = (
  facts: typeof AlarmFacts.Type,
  now: number
): AlarmReadingValue => {
  if (facts.readers === null) {
    return unknown;
  }

  const stuck = facts.readers.seen.filter(
    (reader) =>
      reader.verdict === "stuck" &&
      !duplicateReader(reader, facts, now) &&
      !readerRecovering(
        now - reader.idleSeconds * 1000 + READER_STUCK_MS,
        facts,
        now
      )
  );

  if (stuck.length > 0) {
    const owners = stuck.flatMap((reader) =>
      reader.owner === null ? [] : [reader.owner]
    );

    return {
      evidence: `${stuck.length} live Pi readers made no lease or consume progress for over 5 minutes: ${stuck
        .map(
          (reader) =>
            `${reader.name} on ${reader.host} ${reader.state}${reader.lastError === null ? "" : ` (${reader.lastError})`}${reader.lastReason === undefined ? "" : `: ${reader.lastReason}`} idle ${Math.floor(reader.idleSeconds / 60)}m`
        )
        .join("; ")}`,
      recipients: [...new Set(owners)],
      severity: "warn",
      status: "firing",
    };
  }

  return facts.readers.complete ? ok : unknown;
};

const maintenance = (
  covers: readonly Cover[]
): Extract<AlarmReadingValue, { readonly status: "maintenance" }> => ({
  evidence: covers.map(maintenanceEvidence).join("; "),
  recipients: [...new Set(covers.flatMap((cover) => cover.recipients))],
  status: "maintenance",
  windows: covers.map((cover) => cover.id),
});

const overrun = (
  evidence: string,
  facts: typeof AlarmFacts.Type,
  sources: typeof SourceState.Type,
  instance: string,
  now: number
) => {
  const window = overranWindow(
    facts,
    instance,
    sources.lastUp?.[instance],
    now
  );

  return window === undefined
    ? evidence
    : `${evidence}; ${overrunEvidence(window)}`;
};

export const exposedDownInstances = (
  facts: typeof AlarmFacts.Type,
  now: number
) =>
  (facts.instances ?? []).filter(
    (instance): instance is Extract<typeof instance, { status: "down" }> =>
      instance.status === "down" &&
      coveringWindow(facts, instance.name, now) === undefined
  );

const instanceReading = (
  facts: typeof AlarmFacts.Type,
  sources: typeof SourceState.Type,
  now: number
): AlarmReadingValue => {
  const down = (facts.instances ?? []).filter(
    (instance) => instance.status === "down"
  );

  const exposed = exposedDownInstances(facts, now);

  if (down.length === 0) {
    return ok;
  }

  if (exposed.length === 0) {
    return maintenance(
      down.flatMap((instance) => {
        const cover = coveringWindow(facts, instance.name, now);

        return cover === undefined ? [] : [cover];
      })
    );
  }

  const confirmed = exposed.filter(
    (instance) =>
      (sources.instanceDownChecks?.[instance.name] ?? 0) >= INSTANCE_DOWN_CHECKS
  );

  if (confirmed.length === 0) {
    return unknown;
  }

  const pages = confirmed.some(
    (instance) =>
      instance.page === true &&
      (sources.instanceDownChecks?.[instance.name] ?? 0) >= INSTANCE_DOWN_CHECKS
  );

  return firing(
    pages ? "critical" : "warn",
    confirmed
      .map((instance) =>
        overrun(
          `${instance.name}: ${instance.reason}`,
          facts,
          sources,
          instance.name,
          now
        )
      )
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
    const cover = coveringWindow(facts, MAILBOX_INSTANCE, now);

    return cover === undefined
      ? firing(
          "critical",
          overrun(
            "Mailbox health was not 200 in two consecutive checks",
            facts,
            sources,
            MAILBOX_INSTANCE,
            now
          )
        )
      : maintenance([cover]);
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
  sources: typeof SourceState.Type,
  now: number
): AlarmReadingValue => {
  if (facts.doctor || facts.doctorFinished === false) {
    return ok;
  }

  const named = (facts.doctorReasons ?? []).join("; ");

  if (
    (sources.doctorMisses ?? 0) < ISSUER_FAILURE_CHECKS ||
    now - (sources.doctorFailureSince ?? now) <= ISSUER_FAILURE_SPAN_MS
  ) {
    return unknown;
  }

  return firing(
    "critical",
    `Configuration doctor failed at least 3 consecutive checks spanning more than 2 minutes: ${named || "no reason reported"}`
  );
};

const doctorUnavailableReading = (
  sources: typeof SourceState.Type,
  now: number
): AlarmReadingValue =>
  sources.doctorUnavailableSince !== undefined &&
  now - sources.doctorUnavailableSince >= DOCTOR_UNAVAILABLE_SPAN_MS
    ? firing(
        "warn",
        `Configuration doctor unavailable for at least 15 minutes; identity not checked: ${sources.doctorUnavailableReason}`
      )
    : ok;

const digestReading = (
  facts: typeof AlarmFacts.Type,
  sources: typeof SourceState.Type,
  now: number
): AlarmReadingValue => {
  const stopped = coveringWindow(facts, MAILBOX_INSTANCE, now);

  const checks =
    facts.stopMemory === null || facts.stopMemory === undefined
      ? []
      : stopMemoryChecks(facts.stopMemory);

  const memory = checks
    .filter((check) => stopped === undefined || check.kind !== "unavailable")
    .map((check) => check.text);

  const backup = backupCover(facts.backup ?? null);

  const coveredMeasurements =
    facts.measurementFailed &&
    backup !== undefined &&
    backup.start <= now &&
    now <= backup.end;

  const digestFailed =
    facts.digest === "fail" ||
    (facts.measurementFailed &&
      !coveredMeasurements &&
      (sources.measurementMisses ?? 0) >= 2);

  if (memory.length > 0 || digestFailed) {
    return firing(
      "warn",
      [...(digestFailed ? [digestEvidence(facts)] : []), ...memory].join("; ")
    );
  }

  if (coveredMeasurements) {
    return {
      ...maintenance([backup]),
      evidence: `${maintenanceEvidence(backup)}; ${digestEvidence(facts)}`,
    };
  }

  if (stopped !== undefined && checks.length > memory.length) {
    return maintenance([stopped]);
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
  const sources = {
    ...trackSources(prior, facts, now),
    wakeTargets: rememberMailTargets(prior.wakeTargets ?? [], facts.wakes),
  };

  const readings: typeof Readings.Type = {
    "backup.sessions-index": sessionsBackupReading(facts.sessionsBackup, now),
    "cache.rewrites": cacheReading(facts, now),
    "celld.down": downReading(facts, sources, now),
    "celld.restarted": restartReading(facts, sources, now),
    "digest.fail": digestReading(facts, sources, now),
    "doctor.unavailable": doctorUnavailableReading(sources, now),
    "filer.slots": slotReading(facts),
    "instance.down": instanceReading(facts, sources, now),
    "issuer.broken": doctorReading(facts, sources, now),
    "quarantine.growth": quarantineReading(facts),
    "readers.stuck": readerReading(facts, now),
    "recall.flowing-canary": recallCanaryReading(facts.recallCanary),
    "ship.churn": shipChurnReading(facts, now),
    "ship.failed": shipReading(facts),
    "wake.unacked": ok,
    ...mailReadings(facts.wakes, now),
  };

  const cover = backupCover(facts.backup ?? null);
  const digest = readings["digest.fail"];

  const measurementMaintenance =
    facts.measurementFailed &&
    digest.status === "maintenance" &&
    cover !== undefined
      ? { at: now, evidence: digest.evidence, until: cover.end }
      : null;

  if (
    measurementMaintenance === null &&
    prior.measurementMaintenance === undefined
  ) {
    return { readings, sources };
  }

  return { readings, sources: { ...sources, measurementMaintenance } };
};
