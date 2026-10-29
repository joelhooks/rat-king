import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { expect } from "vitest";

import { Settings } from "../../../packages/ratking-client/src/config.ts";
import { directoryLayer } from "../../../packages/ratking-client/src/directory.ts";
import { Issuer } from "../../../packages/ratking-client/src/issuer.ts";
import { SecretStore } from "../../../packages/ratking-client/src/secrets.ts";
import { provision } from "../provision.ts";

it.live.prop(
  "provision calls the configured issuer once; refuses existing keys and names outside its prefix",
  [Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,8}$/u))],
  ([slug]) =>
    Effect.gen(function* proof() {
      const state = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const values = new Map<string, string>();
      const issued: string[] = [];

      const settings = Layer.succeed(
        Settings,
        Settings.of({
          askTimeoutMs: 1000,
          didTemplate: "did:web:{agent}.agents.example.invalid",
          directory: `${state}/directory.json`,
          documents: [],
          encrypt: false,
          endpoint: "https://mailbox.example.invalid",
          issuer: Option.some({
            endpoint: "https://issuer.example.invalid",
            host: "test-host",
          }),
          refuse: [],
          relays: [],
          reserved: {},
          secretsCommand: "secrets",
          serviceDid: "did:web:mailbox.example.invalid",
          state,
        })
      );

      const wiring = Layer.mergeAll(
        Layer.succeed(SecretStore, {
          add: (name, value) =>
            Effect.sync(() => {
              values.set(name, Redacted.value(value));
            }),
          exists: (name) => Effect.sync(() => values.has(name)),
          lease: (name) =>
            Effect.sync(() => Redacted.make(values.get(name) ?? "")),
        }),
        Layer.succeed(Issuer, {
          ensure: (name, document) =>
            Effect.sync(() => {
              issued.push(name);

              return document.id;
            }),
          names: Effect.succeed([]),
        }),
        directoryLayer.pipe(Layer.provide(settings)),
        settings
      );

      yield* Effect.gen(function* claims() {
        const name = `grokbot/${slug}`;
        expect(yield* provision(name)).toEqual({
          did: `did:web:grokbot.${slug}.agents.example.invalid`,
          name,
        });
        expect(yield* provision(name).pipe(Effect.flip)).toBe(
          "Identity key already exists; not provisioning again."
        );
        expect(yield* provision(`outside/${slug}`).pipe(Effect.flip)).toBe(
          "Name must be under the configured prefix."
        );
        expect(issued).toEqual([name]);
        expect(values.size).toBe(1);
      }).pipe(Effect.provide(wiring));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 } }
);
