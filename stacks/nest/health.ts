import { Clock, DateTime, Duration, Effect, Result, Schema } from "effect";
import { HttpClient } from "effect/http";

import { HostError } from "../../packages/alchemy-nest/src/host-shell.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import { declaredListeners } from "../../packages/alchemy-nest/src/listener-contract.ts";
import {
  readListeners,
  stackListeners,
} from "../../packages/alchemy-nest/src/listeners.ts";
import { nodeService, storeService } from "./backup.ts";
import { healthScript } from "./health-script.ts";

export const backupService = "rat-king-mailbox-backup.service";

export const backupTimer = "rat-king-mailbox-backup.timer";

export const retentionService = "rat-king-storage-retention.service";

export const freshBackupHours = 36;

export const stopMsLimit = 60_000;

export const freeSlotFloor = 0.25;

export const objectSpikeFactor = 3;

export const restartWindowWithoutPrevious = Duration.hours(1);

export const plannedBackupStartGrace = Duration.minutes(2);

export const remoteCommandLimit = Duration.seconds(20);

export const probeLimit = Duration.seconds(30);

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Instant = Schema.DateTimeUtcFromString;

export const UnitState = Schema.Struct({
  activeEnterTimestamp: Schema.NullOr(Instant),
  activeState: Schema.String,
  nRestarts: Count,
});

const Run = Schema.Struct({
  endedAt: Schema.NullOr(Instant),
  result: Schema.String,
  startedAt: Schema.NullOr(Instant),
});

export const Facts = Schema.Struct({
  backup: Schema.Struct({
    lastRun: Schema.NullOr(
      Schema.Struct({
        ...Run.fields,
        memoryPeak: Schema.NullOr(Count),
        stopMs: Schema.NullOr(Count),
      })
    ),
    newest: Schema.NullOr(
      Schema.Struct({
        ageHours: Schema.Finite,
        archiveBytes: Count,
        format: Schema.Int,
        name: Schema.String,
      })
    ),
    nextRun: Schema.NullOr(Instant),
  }),
  health: Schema.Struct({
    latencyMs: Schema.NullOr(Count),
    status: Schema.NullOr(Schema.Int),
  }),
  listeners: Schema.NullOr(Schema.Struct({ count: Count, expected: Count })),
  observedAt: Instant,
  retention: Schema.NullOr(Run),
  services: Schema.Struct({
    celld: Schema.NullOr(UnitState),
    seaweedfs: Schema.NullOr(UnitState),
  }),
  storage: Schema.Struct({
    dataDirs: Schema.NullOr(Schema.Struct({ celld: Count, seaweedfs: Count })),
    objects: Schema.NullOr(
      Schema.Struct({
        bytes: Count,
        collection: Schema.String,
        deleteCount: Count,
        fileCount: Count,
        volumes: Count,
      })
    ),
    slots: Schema.NullOr(
      Schema.Struct({ alarm: Schema.Boolean, free: Count, max: Count })
    ),
  }),
  unavailable: Schema.Record(Schema.String, Schema.String),
});

export type HealthFacts = typeof Facts.Type;

export const Status = Schema.Literals(["ok", "warn", "fail"]);

export const Digest = Schema.Struct({
  ...Facts.fields,
  reasons: Schema.Array(Schema.String),
  status: Status,
});

export type HealthDigest = typeof Digest.Type;

export const DigestJson = Schema.fromJsonString(Digest);

interface Findings {
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
}

const millis = (instant: DateTime.Utc | null) =>
  instant === null ? undefined : DateTime.toEpochMillis(instant);

const insideBackupRun = (enteredAt: number, facts: HealthFacts) => {
  const run = facts.backup.lastRun;
  const began = millis(run?.startedAt ?? null);

  if (began === undefined) {
    return false;
  }

  const ended =
    millis(run?.endedAt ?? null) ?? DateTime.toEpochMillis(facts.observedAt);

  return (
    enteredAt >= began &&
    enteredAt <= ended + Duration.toMillis(plannedBackupStartGrace)
  );
};

const serviceFindings = (facts: HealthFacts, since: number): Findings => {
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const [name, unit] of Object.entries(facts.services)) {
    if (unit === null) {
      continue;
    }

    if (unit.activeState !== "active") {
      failures.push(`${name} ${unit.activeState}`);
    }

    const enteredAt = millis(unit.activeEnterTimestamp);

    if (unit.nRestarts > 0) {
      warnings.push(`${name} restarted ${unit.nRestarts} times`);
    } else if (
      enteredAt !== undefined &&
      enteredAt > since &&
      !insideBackupRun(enteredAt, facts)
    ) {
      warnings.push(`${name} started since the last digest`);
    }
  }

  return { failures, warnings };
};

const storageFindings = (
  facts: HealthFacts,
  previous: HealthDigest | undefined
): Findings => {
  const failures: string[] = [];
  const warnings: string[] = [];
  const { listeners } = facts;
  const { slots } = facts.storage;

  if (listeners !== null && listeners.count !== listeners.expected) {
    failures.push(`listeners ${listeners.count}/${listeners.expected}`);
  }

  if (slots?.alarm === true) {
    failures.push("storage alarm");
  }

  if (slots !== null && slots.free < slots.max * freeSlotFloor) {
    warnings.push(`free volume slots ${slots.free}/${slots.max}`);
  }

  const before = previous?.storage.objects?.fileCount ?? 0;
  const now = facts.storage.objects?.fileCount;

  if (now !== undefined && before > 0 && now > before * objectSpikeFactor) {
    warnings.push(`objects ${before} -> ${now}`);
  }

  return { failures, warnings };
};

const backupFindings = (facts: HealthFacts): Findings => {
  const failures: string[] = [];
  const warnings: string[] = [];
  const { newest, lastRun } = facts.backup;

  if (newest === null && !("backup.newest" in facts.unavailable)) {
    failures.push("no complete backup");
  }

  if (newest !== null && newest.ageHours > freshBackupHours) {
    failures.push(`newest backup ${newest.ageHours.toFixed(1)} h old`);
  }

  if (lastRun !== null && lastRun.result !== "success") {
    warnings.push(`last backup run ${lastRun.result}`);
  }

  if (
    lastRun !== null &&
    lastRun.stopMs !== null &&
    lastRun.stopMs > stopMsLimit
  ) {
    warnings.push(`backup stop ${lastRun.stopMs} ms`);
  }

  return { failures, warnings };
};

const statusOf = (findings: Findings): typeof Status.Type => {
  if (findings.failures.length > 0) {
    return "fail";
  }

  if (findings.warnings.length > 0) {
    return "warn";
  }

  return "ok";
};

export const assess = (facts: HealthFacts, previous?: HealthDigest) => {
  const since =
    millis(previous?.observedAt ?? null) ??
    DateTime.toEpochMillis(facts.observedAt) -
      Duration.toMillis(restartWindowWithoutPrevious);

  const findings = [
    {
      failures:
        facts.health.status === 200
          ? []
          : [`health ${facts.health.status ?? "unreachable"}`],
      warnings: [],
    },
    serviceFindings(facts, since),
    storageFindings(facts, previous),
    backupFindings(facts),
    {
      failures: [],
      warnings: Object.entries(facts.unavailable).map(
        ([field, reason]) => `${field} unavailable: ${reason}`
      ),
    },
  ];

  const total = {
    failures: findings.flatMap((entry) => entry.failures),
    warnings: findings.flatMap((entry) => entry.warnings),
  };

  return {
    reasons: [...total.failures, ...total.warnings],
    status: statusOf(total),
  };
};

const gib = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(2)} GiB`;

export const summarize = (digest: HealthDigest) =>
  [
    `health ${digest.status}`,
    `celld ${digest.services.celld?.activeState ?? "?"}`,
    `seaweedfs ${digest.services.seaweedfs?.activeState ?? "?"}`,
    `http ${digest.health.status ?? "-"} ${digest.health.latencyMs ?? "-"}ms`,
    `listeners ${digest.listeners?.count ?? "?"}/${digest.listeners?.expected ?? "?"}`,
    `slots ${digest.storage.slots?.free ?? "?"}/${digest.storage.slots?.max ?? "?"}`,
    digest.storage.objects === null
      ? "objects ?"
      : `objects ${digest.storage.objects.fileCount} (${gib(digest.storage.objects.bytes)})`,
    `backup ${digest.backup.newest === null ? "none" : `${digest.backup.newest.ageHours.toFixed(1)}h`}`,
    `stop ${digest.backup.lastRun?.stopMs ?? "?"}ms`,
    ...(digest.reasons.length > 0 ? [`(${digest.reasons.join("; ")})`] : []),
  ].join(" · ");

export const parseShow = (text: string) =>
  new Map(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");

        return [line.slice(0, at), line.slice(at + 1).trim()] as const;
      })
  );

export const unixInstant = (value: string | undefined) => {
  const match = /^@(?<seconds>\d+)(?:\.(?<fraction>\d+))?$/u.exec(value ?? "");

  return match?.groups?.seconds === undefined
    ? null
    : DateTime.makeUnsafe(Number(match.groups.seconds) * 1000);
};

const count = (value: string | undefined) =>
  /^\d+$/u.test(value ?? "") ? Number(value) : null;

export const backupAgeHours = (name: string, observedAt: DateTime.Utc) => {
  const match =
    /^(?<y>\d{4})(?<mo>\d{2})(?<d>\d{2})T(?<h>\d{2})(?<mi>\d{2})(?<s>\d{2})/u.exec(
      name
    )?.groups;

  if (match === undefined) {
    return null;
  }

  const created = Date.UTC(
    Number(match.y),
    Number(match.mo) - 1,
    Number(match.d),
    Number(match.h),
    Number(match.mi),
    Number(match.s)
  );

  return (DateTime.toEpochMillis(observedAt) - created) / 3_600_000;
};

export const stopMsFrom = (journal: string) => {
  const values = [...journal.matchAll(/\bBACKUP_STOP_MS (?<ms>\d+)\b/gu)];

  return count(values.at(-1)?.groups?.ms);
};

const Volumes = Schema.fromJsonString(
  Schema.Struct({
    bytes: Count,
    deleteCount: Count,
    fileCount: Count,
    volumes: Count,
  })
);

const Share = Schema.fromJsonString(
  Schema.Struct({
    newest: Schema.NullOr(
      Schema.Struct({
        archiveBytes: Count,
        format: Schema.Int,
        name: Schema.String,
      })
    ),
  })
);

const Slots = Schema.fromJsonString(
  Schema.Struct({
    alarm: Schema.Boolean,
    freeVolumeSlots: Count,
    maxVolumeSlots: Count,
  })
);

export interface HealthInput {
  readonly backupRoot: string;
  readonly bucket: string;
  readonly dataRoot: string;
  readonly healthUrl: string;
  readonly home: string;
  readonly publicIPv4: string;
  readonly sidecar: boolean;
}

const unreadable = (reason: string) =>
  new HostError({ operation: "health", reason });

export const collectHealth = Effect.fn("Nest.health")(function* collectHealth(
  shell: Pick<Interface, "exec">,
  input: HealthInput
) {
  const observedAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
  const unavailable: Record<string, string> = {};

  const bounded = (argv: readonly string[]) =>
    shell.exec([
      "timeout",
      "-k",
      "2",
      String(Duration.toSeconds(remoteCommandLimit)),
      ...argv,
    ]);

  const stdout = (argv: readonly string[]) =>
    bounded(argv).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              unreadable(
                result.code === 124
                  ? "timed out"
                  : `exit ${String(result.code)}`
              )
            )
      )
    );

  const field = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: probeLimit,
        orElse: () => Effect.fail(unreadable("timed out")),
      }),
      Effect.result,
      Effect.map((result) => {
        if (Result.isSuccess(result)) {
          return result.success;
        }

        unavailable[name] = Schema.is(HostError)(result.failure)
          ? result.failure.reason
          : "malformed";

        return null;
      })
    );

  const show = (unit: string, properties: readonly string[]) =>
    stdout([
      "systemctl",
      "--user",
      "show",
      "--timestamp=unix",
      unit,
      ...properties.map((name) => `--property=${name}`),
    ]).pipe(Effect.map(parseShow));

  const unitState = (unit: string) =>
    show(unit, ["ActiveState", "NRestarts", "ActiveEnterTimestamp"]).pipe(
      Effect.flatMap((props) => {
        const activeState = props.get("ActiveState");
        const nRestarts = count(props.get("NRestarts"));

        return activeState === undefined || nRestarts === null
          ? Effect.fail(unreadable("malformed"))
          : Effect.succeed({
              activeEnterTimestamp: unixInstant(
                props.get("ActiveEnterTimestamp")
              ),
              activeState,
              nRestarts,
            });
      })
    );

  const run = (props: ReadonlyMap<string, string>) => ({
    endedAt: unixInstant(props.get("ExecMainExitTimestamp")),
    result: props.get("Result") ?? "unknown",
    startedAt: unixInstant(props.get("ExecMainStartTimestamp")),
  });

  const health = Effect.gen(function* tailnetHealth() {
    const client = yield* HttpClient.HttpClient;
    const began = yield* Clock.currentTimeMillis;

    const response = yield* client.get(input.healthUrl).pipe(
      Effect.mapError(() => unreadable("unreachable")),
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.fail(unreadable("timed out")),
      })
    );

    return {
      latencyMs: (yield* Clock.currentTimeMillis) - began,
      status: response.status,
    };
  });

  const listeners = readListeners({ exec: (argv) => bounded(argv) }).pipe(
    Effect.map((evidence) => ({
      count: stackListeners(evidence.text, evidence.unitCgroups).length,
      expected: declaredListeners(input.publicIPv4, true, input.sidecar).length,
    }))
  );

  const slots = bounded([
    "/usr/bin/python3",
    `${input.home}/.local/share/rat-king/bin/storage-maintenance.py`,
    "diagnose",
  ]).pipe(
    Effect.flatMap((result) =>
      Schema.decodeEffect(Slots)(result.stdout.split("\n")[0] ?? "")
    ),
    Effect.map((signal) => ({
      alarm: signal.alarm,
      free: signal.freeVolumeSlots,
      max: signal.maxVolumeSlots,
    }))
  );

  const objects = stdout([
    "/usr/bin/python3",
    "-c",
    healthScript,
    "volumes",
    input.bucket,
  ]).pipe(
    Effect.flatMap(Schema.decodeEffect(Volumes)),
    Effect.map((totals) => ({ ...totals, collection: input.bucket }))
  );

  const dataDirs = stdout([
    "du",
    "-sb",
    `${input.dataRoot}/celld`,
    `${input.dataRoot}/seaweedfs`,
  ]).pipe(
    Effect.flatMap((text) => {
      const [celld, seaweedfs] = text
        .trim()
        .split("\n")
        .map((line) => count(line.split("\t")[0]));

      return celld === null ||
        celld === undefined ||
        seaweedfs === null ||
        seaweedfs === undefined
        ? Effect.fail(unreadable("malformed"))
        : Effect.succeed({ celld, seaweedfs });
    })
  );

  const lastRun = Effect.gen(function* backupRun() {
    const props = yield* show(backupService, [
      "Result",
      "ExecMainStartTimestamp",
      "ExecMainExitTimestamp",
      "MemoryPeak",
      "InvocationID",
    ]);

    const invocation = props.get("InvocationID") ?? "";

    const journal = /^[0-9a-f]{32}$/u.test(invocation)
      ? yield* stdout([
          "journalctl",
          "--user",
          `--unit=${backupService}`,
          `_SYSTEMD_INVOCATION_ID=${invocation}`,
          "--output=cat",
          "--no-pager",
        ])
      : "";

    return {
      ...run(props),
      memoryPeak: count(props.get("MemoryPeak")),
      stopMs: stopMsFrom(journal),
    };
  });

  const newest = stdout([
    "/usr/bin/python3",
    "-c",
    healthScript,
    "share",
    input.backupRoot,
  ]).pipe(
    Effect.flatMap(Schema.decodeEffect(Share)),
    Effect.flatMap(({ newest: found }) => {
      if (found === null) {
        return Effect.succeed(null);
      }

      const ageHours = backupAgeHours(found.name, observedAt);

      return ageHours === null
        ? Effect.fail(unreadable("malformed"))
        : Effect.succeed({ ...found, ageHours });
    })
  );

  const facts = yield* Effect.all(
    {
      celld: field("services.celld", unitState(nodeService)),
      dataDirs: field("storage.dataDirs", dataDirs),
      health: field("health", health),
      lastRun: field("backup.lastRun", lastRun),
      listeners: field("listeners", listeners),
      newest: field("backup.newest", newest),
      nextRun: field(
        "backup.nextRun",
        show(backupTimer, ["NextElapseUSecRealtime"]).pipe(
          Effect.map((props) =>
            unixInstant(props.get("NextElapseUSecRealtime"))
          )
        )
      ),
      objects: field("storage.objects", objects),
      retention: field(
        "retention",
        show(retentionService, [
          "Result",
          "ExecMainStartTimestamp",
          "ExecMainExitTimestamp",
        ]).pipe(Effect.map(run))
      ),
      seaweedfs: field("services.seaweedfs", unitState(storeService)),
      slots: field("storage.slots", slots),
    },
    { concurrency: 4 }
  );

  return {
    backup: {
      lastRun: facts.lastRun,
      newest: facts.newest,
      nextRun: facts.nextRun,
    },
    health: facts.health ?? { latencyMs: null, status: null },
    listeners: facts.listeners,
    observedAt,
    retention: facts.retention,
    services: { celld: facts.celld, seaweedfs: facts.seaweedfs },
    storage: {
      dataDirs: facts.dataDirs,
      objects: facts.objects,
      slots: facts.slots,
    },
    unavailable,
  } satisfies HealthFacts;
});
