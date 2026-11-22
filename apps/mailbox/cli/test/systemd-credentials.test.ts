import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { expect } from "vitest";

import { SecretSource } from "../../../../packages/alchemy-nest/src/secret-source.ts";
import {
  document,
  identity,
} from "../../../../packages/mailbox-client/test/identity.ts";
import { loadSettings } from "../../../../packages/ratking-client/src/config.ts";
import { runCommand } from "../../../../packages/ratking-client/src/process.ts";
import { secretSource } from "../../../../packages/ratking-client/src/systemd-credentials.ts";
import { billingCredentials } from "../../../../stacks/nest/billing-command.ts";
import {
  StageConfig,
  stageProvider,
} from "../../../../stacks/nest/stage-config.ts";
import { readCliIdentity } from "../identity.ts";
import { SecretStore, secretStoreLayer } from "../secrets.ts";

it.effect.prop(
  "opaque mounted slots remove exactly one LF or CRLF, JSON identities decode unchanged, and malformed slots fail closed",
  [Schema.Int, Schema.Literals(["", "\n", "\r\n", "\n\n", "\r\n\n"])],
  ([id, ending]) =>
    Effect.gen(function* check() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const name = "fixture-signer";
      const raw = `fixture-${id}${ending}`;

      const cut = ending.endsWith("\r\n") ? 2 : Number(ending.endsWith("\n"));
      const value = raw.slice(0, raw.length - cut);
      const signer = yield* identity("did:web:signer.example.invalid");

      yield* fs.writeFileString(
        `${directory}/identity`,
        `${JSON.stringify(signer)}${ending}`
      );
      yield* fs.writeFileString(`${directory}/empty`, "");
      yield* fs.writeFile(`${directory}/wrong-utf8`, new Uint8Array([0xff]));
      expect((yield* runCommand(["mkfifo", `${directory}/fifo`])).code).toBe(0);
      yield* fs.writeFileString(`${directory}/${name}`, raw);
      yield* fs.writeFileString(`${directory}/large`, "x".repeat(65_537));
      yield* fs.symlink(`${directory}/${name}`, `${directory}/linked`);
      yield* fs.makeDirectory(`${directory}/nested`);

      yield* Effect.gen(function* resolve() {
        const store = yield* SecretStore;
        const alchemy = yield* SecretSource;

        expect(yield* store.lease(name)).toBe(value);
        expect(yield* store.exists(name)).toBe(true);
        expect(yield* store.exists("absent")).toBe(false);
        expect(yield* document(yield* readCliIdentity("identity"))).toEqual(
          yield* document(signer)
        );
        expect(Redacted.value(yield* alchemy.resolve({ secret: name }))).toBe(
          value
        );
        expect(yield* readCliIdentity(name).pipe(Effect.flip)).toMatchObject({
          reason: "Systemd identity unavailable or invalid",
        });

        for (const bad of [
          "absent",
          "../fixture-signer",
          "fixture-signer\n",
          "large",
          "linked",
          "nested",
          "empty",
          "fifo",
          "wrong-utf8",
          "UPPER",
          "-leading",
        ]) {
          expect(yield* store.lease(bad).pipe(Effect.isFailure)).toBe(true);

          if (bad !== "absent") {
            expect(yield* store.exists(bad).pipe(Effect.isFailure)).toBe(true);
          }

          expect(
            yield* alchemy.resolve({ secret: bad }).pipe(Effect.isFailure)
          ).toBe(true);
        }
      }).pipe(
        Effect.provide([SecretSource.layer, secretStoreLayer()]),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CREDENTIALS_DIRECTORY: directory,
              RAT_KING_SECRET_SOURCE: "systemd",
            })
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 } }
);

it.effect.prop(
  "stage provider preserves configured systemd and refuses an env downgrade or invalid source",
  [StageConfig],
  ([stage]) =>
    Effect.gen(function* verify() {
      const { alarm: _alarm, mintHost: _mint, ship: _ship, ...base } = stage;

      const config = {
        ...base,
        runtime: {
          ...stage.runtime,
          RAT_KING_AGENT_SECRET_TEMPLATE: "fixture_{agent}_slot",
          RAT_KING_MODEL_GATEWAY_SECRET_NAME: "gateway-slot",
          RAT_KING_OPERATOR_IDENTITY: "operator-slot",
          RAT_KING_SECRET_SOURCE: "systemd" as const,
        },
      };

      const provider = yield* stageProvider(config, {});
      expect(
        yield* secretSource.pipe(Effect.provide(ConfigProvider.layer(provider)))
      ).toBe("systemd");
      expect(
        (yield* stageProvider(config, {
          RAT_KING_SECRET_SOURCE: "agent-secrets",
        }).pipe(Effect.flip)).reason
      ).toBe("Process and stage credential sources disagree");
      expect(
        (yield* stageProvider(config, {
          RAT_KING_SECRET_SOURCE: "invalid",
        }).pipe(Effect.flip)).reason
      ).toBe("Invalid process credential source");
      expect(
        (yield* stageProvider(
          {
            ...config,
            runtime: {
              ...config.runtime,
              RAT_KING_OPERATOR_IDENTITY: "legacy:invalid",
            },
          },
          {}
        ).pipe(Effect.flip)).reason
      ).toBe(
        "Invalid systemd credential reference in runtime.RAT_KING_OPERATOR_IDENTITY"
      );
    }),
  { arbitrary: { runs: 5 } }
);

it.effect(
  "systemd never falls back for unset or relative credential directories or an invalid mode",
  () =>
    Effect.gen(function* verify() {
      for (const config of [
        { RAT_KING_SECRET_SOURCE: "systemd" },
        {
          CREDENTIALS_DIRECTORY: "relative/dir",
          RAT_KING_SECRET_SOURCE: "systemd",
        },
        { RAT_KING_SECRET_SOURCE: "invalid" },
      ]) {
        const result = yield* SecretStore.use((store) =>
          store.lease("fixture")
        ).pipe(
          Effect.provide(
            secretStoreLayer().pipe(
              Layer.provideMerge(
                ConfigProvider.layer(ConfigProvider.fromUnknown(config))
              )
            )
          ),
          Effect.isFailure
        );

        expect(result).toBe(true);
      }
    })
);

it.effect(
  "systemd requires absolute explicit config and state even when HOME contains a valid legacy config",
  () =>
    Effect.gen(function* verify() {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const path = `${home}/.config/rat-king`;

      const good = {
        didTemplate: "did:web:{agent}.example.invalid",
        endpoint: "https://mailbox.example.invalid",
        serviceDid: "did:web:service.example.invalid",
        state: home,
      };

      yield* fs.makeDirectory(path, { recursive: true });
      yield* fs.writeFileString(`${path}/pi.json`, JSON.stringify(good));
      yield* fs.writeFileString(
        `${path}/relative.json`,
        JSON.stringify({ ...good, state: "relative" })
      );
      yield* fs.writeFileString(
        `${path}/relative-documents.json`,
        JSON.stringify({ ...good, documents: ["~/peers.json"] })
      );
      yield* fs.writeFileString(
        `${path}/relative-directory.json`,
        JSON.stringify({ ...good, directory: "./directory.json" })
      );

      const read = (config?: string) =>
        loadSettings().pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                HOME: home,
                RATKING_CONFIG: config,
                RAT_KING_SECRET_SOURCE: "systemd",
              })
            )
          )
        );

      expect(yield* read().pipe(Effect.isFailure)).toBe(true);
      expect(yield* read("relative.json").pipe(Effect.isFailure)).toBe(true);
      expect(yield* read(`${path}/relative.json`).pipe(Effect.isFailure)).toBe(
        true
      );
      expect(
        yield* read(`${path}/relative-documents.json`).pipe(Effect.isFailure)
      ).toBe(true);
      expect(
        yield* read(`${path}/relative-directory.json`).pipe(Effect.isFailure)
      ).toBe(true);
      expect((yield* read(`${path}/pi.json`)).state).toBe(home);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "billing reads only the mounted pull slot in systemd and preserves the legacy bearer",
  [Schema.Int],
  ([nonce]) =>
    Effect.gen(function* verify() {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const value = `fixture-${nonce}`;

      yield* fs.writeFileString(`${dir}/pull-fixture`, `${value}\n`);

      const legacy = "legacy token with spaces";

      const config = {
        BILLING_PULL_CREDENTIAL: legacy,
        CREDENTIALS_DIRECTORY: dir,
        RAT_KING_BILLING_IDENTITY: "fixture-legacy-signer",
        RAT_KING_BILLING_PULL_SLOT: "pull-fixture",
      };

      const check = (
        env: typeof config & { RAT_KING_SECRET_SOURCE?: string }
      ) =>
        billingCredentials().pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
        );

      const mounted = yield* check({
        ...config,
        RAT_KING_SECRET_SOURCE: "systemd",
      });

      const previous = yield* check(config);

      expect(Redacted.value(mounted.token)).toBe(value);
      expect(mounted.identity).toBe("rat_king_script_billing-alerts_identity");
      expect(Redacted.value(previous.token)).toBe(legacy);
      expect(previous.identity).toBe("fixture-legacy-signer");
      expect(
        yield* check({
          ...config,
          RAT_KING_BILLING_PULL_SLOT: "absent",
          RAT_KING_SECRET_SOURCE: "systemd",
        }).pipe(Effect.isFailure)
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 } }
);
