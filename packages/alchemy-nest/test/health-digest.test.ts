import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, DateTime, Duration, Effect, Fiber, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { nodeService, storeService } from "../../../stacks/nest/backup.ts";
import { healthScript } from "../../../stacks/nest/health-script.ts";
import {
  assess,
  backupTimer,
  collectHealth,
  Facts,
  freshBackupHours,
  objectSpikeFactor,
  probeLimit,
  retentionService,
} from "../../../stacks/nest/health.ts";
import type { HealthDigest, HealthFacts } from "../../../stacks/nest/health.ts";
import { declaredListeners } from "../src/listener-contract.ts";
import { localExec } from "../src/local-exec.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const observedAt = "2026-10-09T15:00:00.000Z";

const healthy: HealthFacts = {
  backup: {
    lastRun: {
      endedAt: at("2026-10-09T12:34:32.000Z"),
      memoryPeak: 136_278_016,
      result: "success",
      startedAt: at("2026-10-09T12:32:39.000Z"),
      stopMs: 41_000,
    },
    newest: {
      ageHours: 2.5,
      archiveBytes: 378_553_952,
      format: 4,
      name: "20261009T123419.326905Z-00000000000000000000000000000000",
    },
    nextRun: at("2026-10-10T10:00:00.000Z"),
  },
  health: { latencyMs: 10, status: 200 },
  listeners: { count: 10, expected: 10 },
  observedAt: at(observedAt),
  retention: {
    endedAt: at("2026-10-09T14:15:27.000Z"),
    result: "success",
    startedAt: at("2026-10-09T14:15:27.000Z"),
  },
  services: {
    celld: {
      activeEnterTimestamp: at("2026-10-09T12:33:36.000Z"),
      activeState: "active",
      nRestarts: 0,
    },
    seaweedfs: {
      activeEnterTimestamp: at("2026-10-09T12:33:36.000Z"),
      activeState: "active",
      nRestarts: 0,
    },
  },
  storage: {
    dataDirs: { celld: 58_409_685, seaweedfs: 1_523_063_415 },
    objects: {
      bytes: 461_857_984,
      collection: "rat-king-cells",
      deleteCount: 483_865,
      fileCount: 816_747,
      volumes: 9,
    },
    slots: { alarm: false, free: 39, max: 64 },
  },
  unavailable: {},
};

const digestOf = (facts: HealthFacts): HealthDigest => ({
  ...facts,
  ...assess(facts),
});

it("a healthy host reports ok with no reasons", () => {
  expect(assess(healthy)).toStrictEqual({ reasons: [], status: "ok" });
});

it.prop(
  "a service that is not active fails the digest, whatever else is true",
  [
    Facts,
    Schema.Literals(["celld", "seaweedfs"]),
    Schema.Literals(["inactive", "failed", "activating", "deactivating"]),
  ],
  ([facts, name, activeState]) => {
    const unit = facts.services[name] ?? healthy.services.celld;

    const down = {
      ...facts,
      services: { ...facts.services, [name]: { ...unit, activeState } },
    };

    expect(assess(down).status).toBe("fail");
  }
);

it.prop(
  "the newest complete backup fails the digest exactly when it is older than the freshness limit",
  [Schema.Finite.check(Schema.isBetween({ maximum: 400, minimum: 0 }))],
  ([ageHours]) => {
    const { newest } = healthy.backup;

    if (newest === null) {
      return;
    }

    const facts = {
      ...healthy,
      backup: { ...healthy.backup, newest: { ...newest, ageHours } },
    };

    expect(assess(facts).status).toBe(
      ageHours > freshBackupHours ? "fail" : "ok"
    );
  }
);

it.prop(
  "an object count above the spike factor of the previous digest warns and never fails",
  [
    Schema.Int.check(Schema.isBetween({ maximum: 5_000_000, minimum: 0 })),
    Schema.Int.check(Schema.isBetween({ maximum: 20_000_000, minimum: 0 })),
  ],
  ([before, now]) => {
    const withCount = (fileCount: number): HealthFacts => ({
      ...healthy,
      storage: {
        ...healthy.storage,
        objects: healthy.storage.objects && {
          ...healthy.storage.objects,
          fileCount,
        },
      },
    });

    const result = assess(withCount(now), digestOf(withCount(before)));

    expect(result.status).toBe(
      before > 0 && now > before * objectSpikeFactor ? "warn" : "ok"
    );
  }
);

const nullable = [
  "services.celld",
  "services.seaweedfs",
  "listeners",
  "storage.slots",
  "storage.objects",
  "storage.dataDirs",
  "backup.lastRun",
  "backup.newest",
  "backup.nextRun",
  "retention",
] as const;

const blank = (
  facts: HealthFacts,
  field: (typeof nullable)[number]
): HealthFacts => {
  const [group, key] = field.split(".");

  if (key === undefined) {
    return { ...facts, [field]: null };
  }

  if (group === "services") {
    return { ...facts, services: { ...facts.services, [key]: null } };
  }

  if (group === "storage") {
    return { ...facts, storage: { ...facts.storage, [key]: null } };
  }

  return { ...facts, backup: { ...facts.backup, [key]: null } };
};

it.prop(
  "unreadable host fields degrade the digest to warn with one reason each, never to fail",
  [Schema.Array(Schema.Literals(nullable)).check(Schema.isMinLength(1))],
  ([fields]) => {
    const unique = [...new Set(fields)];

    let facts = healthy;

    for (const field of unique) {
      facts = {
        ...blank(facts, field),
        unavailable: { ...facts.unavailable, [field]: "timed out" },
      };
    }

    const result = assess(facts);
    expect(result.status).toBe("warn");
    expect(result.reasons).toHaveLength(unique.length);
  }
);

it("a readable share with no complete backup fails the digest", () => {
  expect(assess(blank(healthy, "backup.newest")).status).toBe("fail");
});

it.prop(
  "a unit start warns only when it is recent and outside the last backup run",
  [Schema.Int.check(Schema.isBetween({ maximum: 7200, minimum: 0 }))],
  ([secondsAgo]) => {
    const now = Date.parse(observedAt);
    const enteredAt = now - secondsAgo * 1000;
    const began = now - 50 * 60_000;
    const ended = now - 48 * 60_000;

    const facts: HealthFacts = {
      ...healthy,
      backup: {
        ...healthy.backup,
        lastRun: healthy.backup.lastRun && {
          ...healthy.backup.lastRun,
          endedAt: DateTime.makeUnsafe(ended),
          startedAt: DateTime.makeUnsafe(began),
        },
      },
      services: {
        ...healthy.services,
        celld: healthy.services.celld && {
          ...healthy.services.celld,
          activeEnterTimestamp: DateTime.makeUnsafe(enteredAt),
        },
      },
    };

    const planned = enteredAt >= began && enteredAt <= ended + 120_000;
    const recent = enteredAt > now - 3_600_000;

    expect(assess(facts).status).toBe(recent && !planned ? "warn" : "ok");
  }
);

const probes = {
  "backup.lastRun": (argv: readonly string[]) => argv[0] === "journalctl",
  "backup.newest": (argv: readonly string[]) => argv.includes("share"),
  "backup.nextRun": (argv: readonly string[]) => argv.includes(backupTimer),
  listeners: (argv: readonly string[]) => argv[0] === "ss",
  retention: (argv: readonly string[]) => argv.includes(retentionService),
  "services.celld": (argv: readonly string[]) =>
    argv.includes(nodeService) && argv.includes("--property=ActiveState"),
  "services.seaweedfs": (argv: readonly string[]) =>
    argv.includes(storeService) && argv.includes("--property=ActiveState"),
  "storage.dataDirs": (argv: readonly string[]) => argv[0] === "du",
  "storage.objects": (argv: readonly string[]) => argv.includes("volumes"),
  "storage.slots": (argv: readonly string[]) => argv.includes("diagnose"),
};

const cgroup = (unit: string) => `/user.slice/rat-king.slice/${unit}`;

const reply = (argv: readonly string[]) => {
  const control = argv.find((arg) => arg.endsWith(".service"));

  if (argv.includes("--property=ControlGroup") && control !== undefined) {
    return cgroup(control);
  }

  if (argv[0] === "ss") {
    return declaredListeners("192.0.2.10", true, false)
      .map(
        ({ address, port, unit }) =>
          `LISTEN 0 4096 ${address}:${port} 0.0.0.0:* cgroup:${cgroup(unit)}`
      )
      .join("\n");
  }

  if (argv.includes("--property=ActiveState")) {
    return "ActiveState=active\nNRestarts=0\nActiveEnterTimestamp=@1791549216\n";
  }

  if (argv.includes("--property=InvocationID")) {
    return "Result=success\nExecMainStartTimestamp=@1791549159\nExecMainExitTimestamp=@1791549272\nMemoryPeak=136278016\nInvocationID=0123456789abcdef0123456789abcdef\n";
  }

  if (argv[0] === "journalctl") {
    return "[05:33:36.816] INFO (#1): BACKUP_STOP_MS 41000\n";
  }

  if (argv.includes(backupTimer)) {
    return "NextElapseUSecRealtime=@1791626400\n";
  }

  if (argv.includes(retentionService)) {
    return "Result=success\nExecMainStartTimestamp=@1791558927\nExecMainExitTimestamp=@1791558927\n";
  }

  if (argv.includes("diagnose")) {
    return '{"freeVolumeSlots": 39, "maxVolumeSlots": 64, "alarm": false}\n';
  }

  if (argv.includes("volumes")) {
    return '{"fileCount": 816747, "deleteCount": 483865, "bytes": 461857984, "volumes": 9}\n';
  }

  if (argv.includes("share")) {
    return '{"newest": {"name": "20261009T123419.326905Z-00000000000000000000000000000000", "format": 4, "archiveBytes": 378553952}}\n';
  }

  return "58409685\t/data/celld\n1523063415\t/data/seaweedfs\n";
};

it.effect.prop(
  "a hung probe nulls only its own field and the digest still completes",
  [Schema.Literals([...Object.keys(probes), "health"])],
  ([hung]) =>
    Effect.gen(function* hungProbe() {
      yield* TestClock.setTime(Date.parse(observedAt));

      const shell = {
        exec: (argv: readonly string[]) => {
          const command = argv.slice(4);

          const matcher = Object.entries(probes).find(
            ([name]) => name === hung
          )?.[1];

          return matcher !== undefined && matcher(command)
            ? Effect.never
            : Effect.succeed({ code: 0, stdout: reply(command) });
        },
      };

      const client = HttpClient.make((request) =>
        hung === "health"
          ? Effect.never
          : Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("ok"))
            )
      );

      const fiber = yield* collectHealth(shell, {
        backupRoot: "/srv/backups",
        bucket: "rat-king-cells",
        dataRoot: "/data",
        healthUrl: "http://192.0.2.10:18787/.well-known/celld/health",
        home: "/home/example",
        publicIPv4: "192.0.2.10",
        sidecar: false,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkChild
      );

      yield* TestClock.adjust(Duration.toMillis(probeLimit));
      const facts = yield* Fiber.join(fiber);

      expect(facts.unavailable).toStrictEqual({ [hung]: "timed out" });
      expect(assess(facts).status).toBe(hung === "health" ? "fail" : "warn");
    })
);

const shareFixture = String.raw`
import contextlib, io, json, os, pathlib, sys, tempfile
script, entries = sys.argv[1], json.loads(sys.argv[2])
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    complete = []
    for index, kind in enumerate(entries):
        name = '202610%02dT000000.000000Z-%032x' % (1 + index % 28, index)
        path = root / (('.mailbox-publish-' + name) if kind == 'hidden' else name)
        if kind == 'symlink':
            (root / ('target-' + str(index))).mkdir()
            path.symlink_to(root / ('target-' + str(index)))
            continue
        path.mkdir()
        if kind != 'no-manifest':
            (path / 'manifest.json').write_text(json.dumps({'format': 4}))
        if kind != 'no-archive':
            (path / 'mailbox.tar.gz').write_bytes(b'x' * index)
        if kind == 'complete':
            complete.append(name)
    sys.argv = ['health', 'share', str(root)]
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        exec(script, {})
    found = json.loads(out.getvalue())['newest']
    expected = max(complete) if complete else None
    assert (found and found['name']) == expected, (found, expected)
print('NEWEST_COMPLETE_BACKUP_SELECTED')
`;

it.effect.prop(
  "the share reader reports the newest complete backup and skips partial, hidden and linked directories",
  {
    entries: Arbitrary.schema(
      Schema.Array(
        Schema.Literals([
          "complete",
          "no-manifest",
          "no-archive",
          "hidden",
          "symlink",
        ])
      ).check(Schema.isMaxLength(12))
    ),
  },
  ({ entries }) =>
    Effect.gen(function* share() {
      const exec = yield* localExec;

      const result = yield* exec.exec([
        "python3",
        "-I",
        "-c",
        shareFixture,
        healthScript,
        JSON.stringify(entries),
      ]);

      expect(result.stdout.trim()).toBe("NEWEST_COMPLETE_BACKUP_SELECTED");
    }).pipe(Effect.provide(NodeServices.layer))
);
