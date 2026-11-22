import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

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
