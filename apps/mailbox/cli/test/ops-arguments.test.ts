import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { StageConfig } from "../../../../stacks/nest/stage-config.ts";
import { fixtureChild } from "./fixture-child.ts";

it.effect(
  "unknown mailbox and nest flags refuse before reading any live stage config",
  () =>
    Effect.gen(function* check() {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();

      const mailbox = yield* fixtureChild(
        [
          "apps/mailbox/cli/main.ts",
          "register",
          "--did",
          "did:web:example.invalid",
          "--unsupported-fixture",
        ],
        home
      );

      const nest = yield* fixtureChild(
        ["stacks/nest/cli.ts", "ops-digest", "--unsupported-fixture"],
        home
      );

      const error = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ why: Schema.String }))
      )(mailbox.stderr.trim());

      expect(mailbox.code).toBe(2);
      expect(error.why).toBe(
        "Unrecognized flag: --unsupported-fixture in command mailbox register"
      );
      expect(nest.code).not.toBe(0);
      expect(
        `${nest.stdout}${nest.stderr}`
          .split("\n")
          .some((line) => line.endsWith("HostError: Unknown nest flags"))
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "systemd mode refuses legacy send and front desk refuses unsupported argv or legacy mode",
  () =>
    Effect.gen(function* check() {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();

      const checks = yield* Effect.all(
        {
          legacySend: fixtureChild(
            ["stacks/nest/cli.ts", "send", "--to", "sample"],
            home,
            { RAT_KING_SECRET_SOURCE: "systemd" }
          ),
          wrongArgs: fixtureChild(
            ["stacks/nest/cli.ts", "ops-front-desk-send", "--not-stdin"],
            home,
            { RAT_KING_SECRET_SOURCE: "systemd" }
          ),
          wrongProvider: fixtureChild(
            ["stacks/nest/cli.ts", "ops-front-desk-send", "--stdin"],
            home
          ),
        },
        { concurrency: "unbounded" }
      );

      for (const result of Object.values(checks)) {
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain('"ok":true');
      }

      expect(
        `${checks.legacySend.stdout}${checks.legacySend.stderr}`
      ).toContain("Legacy send is disabled with systemd credentials");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "done-bar keeps exit 1 and the HostError diagnostic when a local receipt was lost",
  [StageConfig],
  ([base]) =>
    Effect.gen(function* failure() {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const stage = `${home}/stage.json`;
      const at = DateTime.formatIso(yield* TestClock.withLive(DateTime.now));

      const line = JSON.stringify({
        at,
        fallback: { status: "failed" },
        path: "intercom-fallback",
      });

      const frame = JSON.stringify({ kind: "receipt", line });

      yield* fs.writeFileString(
        `${home}/python3`,
        `#!/bin/sh\nprintf '%s\\n' '${frame}'\n`,
        { mode: 0o700 }
      );
      yield* fs.writeFileString(
        stage,
        yield* Schema.encodeEffect(Schema.fromJsonString(StageConfig))({
          ...base,
          comms: { local: base.comms.local },
          runtime: {
            ...base.runtime,
            HOME: home,
            RAT_KING_OFFLINE_PLAN: false,
            RAT_KING_SECRET_SOURCE: "agent-secrets",
            RAT_KING_STATE_DIR: home,
          },
        })
      );

      const result = yield* fixtureChild(
        ["stacks/nest/cli.ts", "done-bar"],
        home,
        { RAT_KING_STAGE_CONFIG: stage }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("HostError: Done-bar not met");
      expect(result.stdout.split("\n")[0]).toBe(
        JSON.stringify({
          local: { fallbacks: 1, lost: 1, quarantined: 0, sent: 1 },
          passed: false,
          remote: null,
        })
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 2 } }
);
