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
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { expect } from "vitest";

import { RuntimeFiles } from "../../../packages/alchemy-nest/src/agent-runtime-files.ts";
import { Deployment } from "../../../packages/alchemy-nest/src/deployment.ts";
import { textDigest } from "../../../packages/alchemy-nest/src/files.ts";
import { SecretSource } from "../../../packages/alchemy-nest/src/secret-source.ts";
import {
  Rendered,
  renderProviders,
} from "../../../packages/alchemy-nest/test/instance-render.ts";
import { mailboxManifest } from "../../../stacks/nest/prepared-manifest.ts";
import { run } from "../../../stacks/nest/runtime.ts";
import { preparedStageProvider } from "../../../stacks/nest/stage-config.ts";
import type { StageConfigValue } from "../../../stacks/nest/stage-config.ts";

const workerBytes =
  "throw new Error('candidate bytes must never execute in signer')";

const sha = "2".repeat(40);

const fakeProviders = (
  applied: { config: string; worker: string; projection: string }[]
) => {
  const renderer = renderProviders.pipe(
    Layer.provideMerge(
      SecretSource.fromRecord({
        fake_access_name: "fixture-access",
        fake_secret_name: "fixture-secret",
      })
    )
  );

  const deployment = Provider.effect(
    Deployment,
    Effect.gen(function* renderDeployment() {
      const fs = yield* FileSystem.FileSystem;
      const rendered = yield* Rendered;
      const source = yield* Config.String("RAT_KING_SECRET_SOURCE");
      const credentials = yield* Config.String("CREDENTIALS_DIRECTORY");
      const projection = yield* fs.readFileString(`${credentials}/fixture`);

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
              projection: `${source}:${projection}`,
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
  };
};

it.effect.prop(
  "run deploy gives the fake Alchemy provider candidate manifest bytes and ambient credentials",
  [Schema.Int.check(Schema.isBetween({ maximum: 28, minimum: 1 }))],
  ([day]) =>
    Effect.gen(function* preparedApply() {
      const date = `2026-11-${String(day).padStart(2, "0")}`;

      const applied: { config: string; worker: string; projection: string }[] =
        [];

      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${root}/fixture`, "fixture-credential", {
        mode: 0o600,
      });
      yield* fs.writeFileString(`${root}/claude-mtimes.json`, "{}");
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
      yield* run(
        "deploy",
        {
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
        },
        {
          listener: () => Effect.succeed("fixture ready"),
          providers: fakeProviders(applied),
        }
      ).pipe(
        Effect.provideService(FetchHttpClient.Fetch, () => {
          throw new Error(
            "Prepared apply attempted network I/O in the fake-provider fixture"
          );
        }),
        Effect.provide(
          preparedStageProvider(stage(root)).pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  CREDENTIALS_DIRECTORY: root,
                  RAT_KING_SECRET_SOURCE: "systemd",
                })
              )
            )
          )
        )
      );
      expect(applied).toHaveLength(1);
      expect(applied[0]?.config).toContain(`"compatibility_date":"${date}"`);
      expect(applied[0]?.projection).toBe("systemd:fixture-credential");
      expect(applied[0]?.worker).toBe(workerBytes);
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 } }
);
