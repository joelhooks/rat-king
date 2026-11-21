import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Match, Option, Schema } from "effect";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Settings } from "../src/config.ts";
import { Directory, directoryLayer } from "../src/directory.ts";
import { ensureIdentity } from "../src/identity.ts";
import { Issuer } from "../src/issuer.ts";
import { AgentName } from "../src/name.ts";
import { SecretStore } from "../src/secrets.ts";

it.effect.prop(
  "unreadable directories are preserved and block identity provisioning",
  [AgentName, Schema.Literals(["syntax", "shape", "key"])],
  ([name, problem]) =>
    Effect.gen(function* corruptDirectory() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const file = `${state}/directory.json`;

      const peer = yield* document(
        yield* identity("did:web:peer.example.invalid")
      );

      const raw = Match.value(problem).pipe(
        Match.when("syntax", () => "{"),
        Match.when("shape", () => JSON.stringify({ [name]: { did: peer.id } })),
        Match.when("key", () =>
          JSON.stringify({ "!": { did: peer.id, document: peer } })
        ),
        Match.exhaustive
      );

      yield* fs.writeFileString(file, raw);

      const settings = Layer.succeed(Settings, {
        askTimeoutMs: 1000,
        didTemplate: "did:web:{agent}.example.invalid",
        directory: file,
        documents: [],
        encrypt: false,
        endpoint: "https://mailbox.example.invalid",
        issuer: Option.none(),
        refuse: [],
        relays: [],
        reserved: {},
        secretsCommand: "unused",
        serviceDid: "did:web:mailbox.example.invalid",
        state,
      });

      const recordFailure = yield* Directory.use((directory) =>
        directory.record(name, peer)
      ).pipe(
        Effect.provide(directoryLayer.pipe(Layer.provide(settings))),
        Effect.flip
      );

      expect(recordFailure._tag).toBe("DirectoryError");
      expect(recordFailure.reason).toContain("directory is unreadable");

      const provision = yield* ensureIdentity(name).pipe(
        Effect.provide(
          Layer.mergeAll(
            settings,
            Layer.mock(SecretStore, {}),
            Layer.mock(Issuer, {})
          )
        ),
        Effect.flip
      );

      expect(provision.reason).toBe(recordFailure.reason);

      expect(yield* fs.readFileString(file)).toBe(raw);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 15 } }
);
