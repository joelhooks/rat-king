import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Console, Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { MailboxHealth } from "../../../../packages/mailbox-client/src/health.ts";
import { Counts } from "../../../../stacks/nest/comms.ts";
import {
  Digest,
  parseShow,
  serviceLimits,
} from "../../../../stacks/nest/health.ts";
import type { HealthDigest } from "../../../../stacks/nest/health.ts";
import {
  opsDigest,
  projectMailboxOpsHealth,
  projectOpsDigest,
  projectOpsHealth,
} from "../../../../stacks/nest/ops-read.ts";
import { StageConfig } from "../../../../stacks/nest/stage-config.ts";

const plantDetails = (health: HealthDigest, probe: string): HealthDigest => ({
  ...health,
  backup: {
    ...health.backup,
    newest: { ageHours: 0, archiveBytes: 0, format: 0, name: probe },
  },
  listeners: { count: 0, expected: 0, foreign: [probe] },
  reasons: [probe],
  retention: { endedAt: null, result: probe, startedAt: null },
  services: {
    celld: { activeEnterTimestamp: null, activeState: probe, nRestarts: 0 },
    seaweedfs: { activeEnterTimestamp: null, activeState: probe, nRestarts: 0 },
  },
  storage: {
    ...health.storage,
    objects: {
      bytes: 0,
      collection: probe,
      deleteCount: 0,
      fileCount: 0,
      volumes: 0,
    },
  },
  unavailable: { [probe]: probe },
});

it.prop(
  "ops digest exposes no diagnostic, backup, service, or object names",
  [Digest, Counts, Schema.Int],
  ([health, counts, nonce]) => {
    const probe = `private diagnostic ${nonce}`;
    const output = projectOpsDigest(plantDetails(health, probe), counts, 100);

    expect(JSON.stringify(output)).not.toContain(probe);
    expect(output).toMatchObject({
      comms: {
        fallbacks_24h: counts.fallbacks,
        lost_24h: counts.lost,
        quarantined_24h: counts.quarantined,
        sent_24h: counts.sent,
      },
      issueCount: 1,
      mailbox: {
        status: health.status,
        storage: { slots: health.storage.slots },
      },
    });
  }
);

it.prop(
  "ops health exposes no private metadata and distinguishes retired, expired, incomplete and current readers",
  [
    Digest,
    MailboxHealth,
    Schema.Int,
    Schema.Boolean,
    Schema.Boolean,
    Schema.Boolean,
  ],
  ([health, facts, nonce, retired, complete, expired]) => {
    const probe = `private diagnostic ${nonce}`;

    const output = projectOpsHealth(
      "example/row",
      {
        ...facts,
        complete,
        lease: {
          expiresAt: expired ? 98 : 100,
          generation: 1,
          holder: probe,
          pane: probe,
        },
        oldestWake: { at: 0, id: probe, sender: probe },
        oldestWakeSinceAck: { at: 0, id: probe, sender: probe },
        retired,
      },
      plantDetails(health, probe),
      99
    );

    const expectedReader = complete && !expired ? "ok" : "unknown";
    const expected = retired ? "retired" : expectedReader;

    expect(JSON.stringify(output)).not.toContain(probe);
    expect(output).toMatchObject({
      mailbox: {
        status: health.status,
        storage: { slots: health.storage.slots },
      },
      name: "example/row",
      status: expected,
    });
  }
);

it.effect.prop(
  "ops-digest prints one bounded JSON value without touching legacy history",
  [StageConfig, Digest, Schema.Int],
  ([base, health, nonce]) =>
    Effect.gen(function* verify() {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const history = `${dir}/health.jsonl`;
      const prior = `fixture prior ${nonce}\n`;
      const lines: string[] = [];

      yield* fs.writeFileString(history, prior);
      yield* fs.writeFileString(`${dir}/receipts`, "");
      yield* fs.makeDirectory(`${dir}/quarantine`);

      const config = {
        ...base,
        comms: {
          ...base.comms,
          local: {
            quarantine: `${dir}/quarantine`,
            receipts: `${dir}/receipts`,
          },
        },
        runtime: { ...base.runtime, RAT_KING_STATE_DIR: dir },
      };

      yield* opsDigest(config, Effect.succeed(health)).pipe(
        Effect.provideService(Console.Console, {
          ...console,
          log: (value: string) => {
            lines.push(value);
          },
        })
      );

      expect(yield* fs.readFileString(history)).toBe(prior);
      expect(lines).toHaveLength(1);
      expect(new TextEncoder().encode(lines[0]).byteLength).toBeLessThan(2048);
      expect(lines[0]).toContain('"mailbox":');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 } }
);

it("parses the property layout captured from systemctl --timestamp=unix show", () => {
  const props = parseShow(
    "ActiveState=active\nActiveEnterTimestamp=@1795227178\nMainPID=2096\nNRestarts=0\nMemoryMax=infinity\n"
  );

  expect(props.get("ActiveEnterTimestamp")).toBe("@1795227178");
  expect(serviceLimits(props)).toEqual({
    mainPidPresent: true,
    memoryMax: "infinity",
  });
});

it.prop(
  "mailbox service health exposes only enum, PID presence, restart count and memory limit",
  [
    Digest,
    Schema.Int.check(Schema.isGreaterThan(0)),
    Schema.Literals(["1073741824", "infinity", "9007199254740993"]),
  ],
  ([health, pid, memory]) => {
    const probe = `private-path-${pid}`;

    const fixture = {
      activeEnterTimestamp: null,
      activeState: probe,
      ...serviceLimits(
        new Map([
          ["MainPID", String(pid)],
          ["MemoryMax", memory],
        ])
      ),
      nRestarts: 0,
    };

    const output = projectMailboxOpsHealth({
      ...health,
      services: { celld: fixture, seaweedfs: null },
    });

    expect(output.services).toEqual({
      celld: {
        activeState: "unknown",
        mainPidPresent: true,
        memoryMax: memory === "1073741824" ? 1_073_741_824 : memory,
        nRestarts: 0,
      },
      seaweedfs: null,
    });
    expect(JSON.stringify(output)).not.toContain(probe);
  }
);
