import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { inMemoryState } from "alchemy";
import * as Provider from "alchemy/Provider";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { expect } from "vitest";

import { RuntimeFiles } from "../../../packages/alchemy-nest/src/agent-runtime-files.ts";
import { Deployment } from "../../../packages/alchemy-nest/src/deployment.ts";
import {
  digest,
  textDigest,
} from "../../../packages/alchemy-nest/src/files.ts";
import { SecretSource } from "../../../packages/alchemy-nest/src/secret-source.ts";
import {
  Rendered,
  renderProviders,
} from "../../../packages/alchemy-nest/test/instance-render.ts";
import { preparedApply } from "../../../stacks/nest/prepared-apply.ts";
import { mailboxManifest } from "../../../stacks/nest/prepared-manifest.ts";
import { encodePrepared } from "../../../stacks/nest/prepared-payload.ts";
import { execute, shipCommand } from "../../../stacks/nest/ship-command.ts";
import {
  ShipCheckpoint,
  ShipReceipt,
} from "../../../stacks/nest/ship-config.ts";
import { withShipLock } from "../../../stacks/nest/ship-lock.ts";
import { readCommand } from "../../../stacks/nest/ship-process.ts";
import { FleetError } from "../../../stacks/nest/stage-config.ts";
import type { StageConfigValue } from "../../../stacks/nest/stage-config.ts";

const workerBytes =
  "throw new Error('candidate bytes must never execute in signer')";

const sha = "2".repeat(40);

const fakeProviders = (
  applied: { config: string; worker: string; projection: string }[]
) => {
  const renderer = renderProviders.pipe(Layer.provideMerge(SecretSource.layer));

  const deployment = Provider.effect(
    Deployment,
    Effect.gen(function* renderDeployment() {
      const rendered = yield* Rendered;
      const source = yield* Config.String("RAT_KING_SECRET_SOURCE");
      const secrets = yield* SecretSource;
      const projection = yield* secrets.resolve({ secret: "fixture" });

      return Deployment.Provider.of({
        delete: () => Effect.void,
        list: () => Effect.succeed([]),
        read: ({ output }) => Effect.succeed(output),
        reconcile: ({ news }) =>
          Effect.sync(() => {
            expect(
              rendered.files.get(
                "/home/example/.config/rat-king/mailbox-deployment/worker.mjs"
              )
            ).toBe(workerBytes);
            applied.push({
              config: news.configuration,
              projection: `${source}:${Redacted.value(projection)}`,
              worker: news.bundle,
            });

            return { ...news, sha256: textDigest(news.bundle) };
          }),
      });
    }).pipe(Effect.orDie)
  );

  const hosted = Provider.succeed(RuntimeFiles, {
    delete: () => Effect.die("Hosted provider not permitted"),
    list: () => Effect.die("Hosted provider not permitted"),
    read: () => Effect.die("Hosted provider not permitted"),
    reconcile: () => Effect.die("Hosted provider not permitted"),
  });

  return {
    providers: Layer.merge(deployment, hosted).pipe(
      Layer.provideMerge(renderer)
    ),
    state: inMemoryState(),
  };
};

const stage = (root: string): StageConfigValue => {
  const paths = { quarantine: root, receipts: root };

  return {
    comms: { local: paths, remote: { ...paths, ssh: "example" } },
    runtime: {
      HOME: root,
      RATS_NEST_INSTANCE: `${root}/instance.json`,
      RAT_KING_AGENT_MODEL: "faux",
      RAT_KING_AGENT_SECRET_TEMPLATE: "test_{agent}",
      RAT_KING_BACKUP_ROOT: root,
      RAT_KING_CLAUDE_SIDECAR: false,
      RAT_KING_CLI_OUTPUT: `${root}/must-not-read.mjs`,
      RAT_KING_COMMIT: sha,
      RAT_KING_DOCUMENTS: `${root}/documents.json`,
      RAT_KING_ENDPOINT: "https://mail.example.invalid",
      RAT_KING_ISSUER_RESERVED: [],
      RAT_KING_LEASE_RESOLVERS: [],
      RAT_KING_LIVE_NODE: "example",
      RAT_KING_OBSERVER_DIDS: [],
      RAT_KING_OFFLINE_PLAN: true,
      RAT_KING_OPERATOR_DIDS: ["did:web:operator.example.invalid"],
      RAT_KING_OPERATOR_IDENTITY: "fixture",
      RAT_KING_SERVICE_DID: "did:web:mail.example.invalid",
      RAT_KING_SLICE_MEMORY_MAX: "256M",
      RAT_KING_STAGE: "fleet",
      RAT_KING_START_APPROVED: true,
      RAT_KING_STATE_DIR: root,
      RAT_KING_VERSION: "1.2.3",
    },
    shipAttempt: {
      events: `${root}/events`,
      restart: {
        lock: `${root}/lock`,
        marker: `${root}/marker`,
        unit: "test.service",
        units: ["test.service"],
      },
      sha,
    },
  };
};

it.effect.prop(
  "run deploy gives the fake Alchemy provider candidate manifest bytes and ambient credentials",
  [Schema.Int.check(Schema.isBetween({ maximum: 28, minimum: 1 }))],
  ([day]) =>
    Effect.gen(function* checkApply() {
      const date = `2026-11-${String(day).padStart(2, "0")}`;

      const applied: { config: string; worker: string; projection: string }[] =
        [];

      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${root}/fixture`, "fixture-credential", {
        mode: 0o600,
      });
      yield* fs.writeFileString(`${root}/fake_access_name`, "fixture-access", {
        mode: 0o600,
      });
      yield* fs.writeFileString(`${root}/fake_secret_name`, "fixture-secret", {
        mode: 0o600,
      });
      yield* fs.writeFileString(`${root}/claude-mtimes.json`, "{}");
      yield* fs.writeFileString(`${root}/events`, "", { mode: 0o600 });
      yield* fs.writeFileString(
        `${root}/documents.json`,
        JSON.stringify([
          {
            authentication: [],
            id: "did:web:operator.example.invalid",
            keyAgreement: [],
            verificationMethod: [],
          },
        ])
      );
      yield* fs.writeFileString(
        `${root}/instance.json`,
        JSON.stringify({
          domains: ["example.invalid"],
          hosts: ["example"],
          ips: ["203.0.113.10"],
          nodes: {
            example: {
              dataRoot: "/srv/example",
              home: "/home/example",
              ssh: "example",
              tailnetIPv4: "203.0.113.10",
            },
          },
          s3Credentials: {
            accessKey: "fake_access_name",
            secretKey: "fake_secret_name",
          },
          secretNames: ["fixture"],
          sites: ["example"],
        }),
        { mode: 0o600 }
      );
      const stageFile = `${root}/stage.json`;
      const bundleFile = `${root}/verified.bundle`;

      const candidate = {
        backup: workerBytes,
        cli: workerBytes,
        commit: sha,
        manifest: {
          ...mailboxManifest,
          declaration: {
            ...mailboxManifest.declaration,
            compatibility_date: date,
          },
        },
        restart: workerBytes,
        version: "1.2.3",
        worker: workerBytes,
      };

      const bytes = encodePrepared(candidate);
      const fixture = stage(root);
      yield* fs.writeFileString(
        stageFile,
        JSON.stringify({
          ...fixture,
          runtime: { ...fixture.runtime, RAT_KING_SECRET_SOURCE: "systemd" },
        }),
        {
          mode: 0o600,
        }
      );
      yield* fs.writeFile(
        bundleFile,
        encodePrepared({ ...candidate, version: "1.2.4" }),
        { mode: 0o600 }
      );

      const run = (args: readonly string[], secretSource = "systemd") =>
        preparedApply(args, {
          beforeDeploy: () => Effect.void,
          listener: () => Effect.succeed("fixture ready"),
          providers: (trusted) => {
            const fake = fakeProviders(applied);

            return {
              providers: Layer.merge(trusted.providers, fake.providers),
              state: fake.state,
            };
          },
        }).pipe(
          Effect.provideService(FetchHttpClient.Fetch, () => {
            throw new Error(
              "Prepared apply attempted network I/O in the fake-provider fixture"
            );
          }),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                CREDENTIALS_DIRECTORY: root,
                RAT_KING_SECRET_SOURCE: secretSource,
                RAT_KING_STAGE_CONFIG: stageFile,
              })
            )
          )
        );

      for (const [args, reason] of [
        [[], "Usage: prepared-apply"],
        [
          [bundleFile, "3".repeat(40), digest(bytes)],
          "Prepared apply attempt SHA refused",
        ],
        [
          [bundleFile, sha, digest(bytes)],
          "Prepared fleet bundle pin mismatch",
        ],
        [
          [
            bundleFile,
            sha,
            digest(encodePrepared({ ...candidate, version: "1.2.4" })),
          ],
          "Prepared apply attempt version refused",
        ],
      ] as const) {
        const failure = yield* run(args).pipe(Effect.result);
        expect(
          Result.isFailure(failure) &&
            Schema.is(FleetError)(failure.failure) &&
            failure.failure.reason
        ).toContain(reason);
      }

      expect(applied).toHaveLength(0);
      yield* fs.writeFile(bundleFile, bytes);

      const mismatch = yield* run(
        [bundleFile, sha, digest(bytes)],
        "agent-secrets"
      ).pipe(Effect.result);

      expect(
        Result.isFailure(mismatch) &&
          Schema.is(FleetError)(mismatch.failure) &&
          mismatch.failure.reason
      ).toBe("Process and stage credential sources disagree");
      expect(applied).toHaveLength(0);
      yield* run([bundleFile, sha, digest(bytes)]);
      expect(applied).toHaveLength(1);
      expect(applied[0]?.config).toContain(`"compatibility_date":"${date}"`);
      expect(applied[0]?.projection).toBe("systemd:fixture-credential");
      expect(applied[0]?.worker).toBe(workerBytes);
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 } }
);

const testShipStage = (root: string): StageConfigValue => ({
  ...stage(root),
  ship: {
    bot: "fixture",
    checkpoint: `${root}/checkpoint`,
    intervalSeconds: 1,
    launchd: {
      errorLog: root,
      label: "fixture",
      node: process.execPath,
      outputLog: root,
      path: "/usr/bin",
      pnpm: "pnpm",
    },
    notify: {
      directory: root,
      from: "test",
      secret: "test",
      to: ["test-desk"],
    },
    receipts: `${root}/receipts`,
    releases: `${root}/releases`,
    repository: "example/fixture",
    restart: {
      lock: `${root}/lock`,
      marker: `${root}/marker`,
      unit: "test.service",
      units: ["test.service"],
    },
    source: root,
  },
});

it.effect(
  "prepared command persists holds, pages by reason, and never records the live SHA",
  () =>
    Effect.gen(function* checkHolds() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const config = testShipStage(root);
      const checkpoint = `${root}/checkpoint`;
      const live = "0".repeat(40);
      const old = "f".repeat(40);

      const backlog = Array.from({ length: 256 }, (_, i) =>
        (i + 1).toString(16).padStart(40, "0")
      );

      const head = backlog.at(-1) ?? live;
      const pages: string[] = [];
      yield* fs.writeFileString(
        checkpoint,
        JSON.stringify({ failed: "", successful: live }),
        { mode: 0o600 }
      );

      const cycle = (eligible: readonly string[], reason: string) =>
        Effect.gen(function* runCycle() {
          let checked = false;

          return yield* shipCommand(
            config,
            Effect.die("readiness holds must not recover storage"),
            [
              "--candidate-file",
              `${root}/candidates`,
              "--artifact-helper",
              `${root}/helper`,
            ],
            {
              drifted: Effect.sync(() => {
                const before = checked;
                checked = true;

                return before;
              }),
              evidence: {
                artifact: () =>
                  Effect.die("held candidate may not open a bundle"),
                eligible: Effect.succeed(new Set(eligible)),
                fence: () => Effect.fail(new FleetError({ reason })),
                firstParent: (candidate) =>
                  Effect.succeed(
                    backlog[backlog.indexOf(candidate) - 1] ?? live
                  ),
                head: Effect.succeed(head),
              },
              page: (message) =>
                Effect.sync(() => {
                  pages.push(message);
                }),
              workspace: () => Effect.void,
            }
          );
        });

      yield* cycle([], "unused");
      expect(pages).toHaveLength(1);
      expect(yield* fs.exists(`${root}/receipts`)).toBe(false);

      const saved = yield* Schema.decodeEffect(
        Schema.fromJsonString(ShipCheckpoint)
      )(yield* fs.readFileString(checkpoint));

      expect(saved.preparedHolds).toEqual({ global: "NoPinnedCandidates" });

      yield* cycle([old, live, ...backlog], "ExactFencePending");
      expect(pages).toHaveLength(1);
      yield* cycle([old, live, ...backlog], "ExactFencePendingOverdue");
      expect(pages).toHaveLength(2);
      yield* cycle(backlog.toReversed(), "ExactFencePendingOverdue");
      expect(pages).toHaveLength(2);

      const receipts = (yield* fs.readFileString(`${root}/receipts`))
        .trimEnd()
        .split("\n")
        .map((line) =>
          Schema.decodeSync(Schema.fromJsonString(ShipReceipt))(line)
        );

      expect(receipts).toHaveLength(256);
      expect(new Set(receipts.map((receipt) => receipt.sha)).size).toBe(256);
      expect(
        receipts.every((receipt) => receipt.hold === "ExactFencePendingOverdue")
      ).toBe(true);
      expect(
        receipts.every(
          (receipt) =>
            receipt.result === "held" &&
            receipt.sha !== old &&
            receipt.sha !== live
        )
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "a locked legacy worker fetches main and stops cleanly on checkpoint drift",
  () =>
    Effect.gen(function* legacyCycle() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const source = `${root}/source`;
      const state = `${root}/state`;
      const caller = `${root}/caller`;
      const bot = `${root}/checks`;
      const checkpoint = `${root}/checkpoint`;
      const configPath = `${root}/stage.json`;
      yield* Effect.forEach(
        [source, state, caller],
        (dir) => fs.makeDirectory(dir),
        { discard: true }
      );

      const git = (args: readonly string[]) =>
        readCommand("git", args, source, 4096, {
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          HOME: root,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        });

      yield* git(["init", "-b", "main", "-q"]);
      yield* git([
        "-c",
        "user.email=fixture",
        "-c",
        "user.name=Fixture",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      ]);
      yield* git(["remote", "add", "origin", "."]);
      const pushed = (yield* git(["rev-parse", "HEAD"])).trim();
      yield* fs.writeFileString(
        checkpoint,
        JSON.stringify({ failed: "", successful: "0".repeat(40) }),
        { mode: 0o600 }
      );

      const stageValue = testShipStage(root);
      const { ship } = stageValue;

      if (ship === undefined) {
        return yield* Effect.die("Missing fixture ship config");
      }

      yield* fs.writeFileString(
        configPath,
        JSON.stringify({
          ...stageValue,
          runtime: { ...stageValue.runtime, RAT_KING_STATE_DIR: state },
          ship: { ...ship, bot, source },
        }),
        { mode: 0o600 }
      );
      yield* fs.writeFileString(
        bot,
        `#!/bin/sh
set -eu
test "$1" = checks
test "$3" = ${pushed}
printf '%s\\n' '${JSON.stringify({ failed: "", successful: pushed })}' > '${checkpoint}'
printf '%s\\n' '${JSON.stringify({ ok: true, result: { check_runs: [], sha: pushed } })}'
`,
        { mode: 0o700 }
      );
      const path = yield* Path.Path;

      const entry = yield* path.fromFileUrl(
        new URL("../../../stacks/nest/ship-worker.ts", import.meta.url)
      );

      yield* withShipLock(state, entry, configPath, ["ship"], caller).pipe(
        Effect.timeout("10 seconds")
      );

      const saved = yield* Schema.decodeEffect(
        Schema.fromJsonString(ShipCheckpoint)
      )(yield* fs.readFileString(checkpoint));

      expect(saved.successful).toBe(pushed);
      expect((yield* git(["rev-parse", "origin/main"])).trim()).toBe(pushed);
      expect(yield* fs.exists(`${root}/receipts`)).toBe(false);

      const orphaned = yield* execute(
        process.execPath,
        [entry, "ship"],
        caller,
        {
          RAT_KING_STAGE_CONFIG: configPath,
        }
      ).pipe(Effect.timeout("10 seconds"));

      expect(orphaned.code).not.toBe(0);
      expect(orphaned.stderrTail).toContain("ShipLockSupervisorLost");

      return yield* Effect.void;
    }).pipe(Effect.provide(NodeServices.layer))
);
