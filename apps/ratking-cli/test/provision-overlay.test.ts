import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Settings } from "@rat-king/ratking-client/config";
import { Directory, directoryLayer } from "@rat-king/ratking-client/directory";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { provisionFromFlags } from "../../mailbox/cli/main.ts";
import { SecretStore } from "../../mailbox/cli/secrets.ts";
import { document, identity } from "../../mailbox/cli/test/helpers.ts";
import { memorySecretStoreLayer } from "../../mailbox/cli/test/secret-store.ts";
import { provisionAndRestore } from "../src/operator.ts";

it.effect.prop(
  "standalone mailbox provisioning preserves the overlay; ratking provisioning clears it only after success",
  [Schema.Boolean],
  ([refused]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const operator = yield* identity("did:web:operator.example.invalid");
      const docs = `${state}/documents.json`;
      const identities = `${state}/directory.json`;
      yield* fs.writeFileString(
        docs,
        JSON.stringify([yield* document(operator)])
      );
      yield* fs.writeFileString(identities, "{}\n");

      const directory = yield* Directory.pipe(
        Effect.provide(
          directoryLayer.pipe(
            Layer.provide(
              Layer.succeed(
                Settings,
                Settings.of({
                  askTimeoutMs: 1000,
                  didTemplate: "did:web:{agent}.example.invalid",
                  directory: identities,
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
                })
              )
            )
          )
        )
      );

      const flags = {
        agent: "example",
        did: "did:web:example.example.invalid",
        secret: Option.some("agent"),
        secretsConfig: Option.none<string>(),
        secretsSocket: Option.none<string>(),
      };

      yield* directory.importRetired([flags.agent]);
      const overlay = yield* fs.readFileString(`${state}/retired.json`);
      let conflict = false;

      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              conflict ? { error: "DocumentConflict" } : { did: flags.did },
              { status: conflict ? 409 : 200 }
            )
          )
        )
      );

      yield* Effect.gen(function* commands() {
        const store = yield* SecretStore;
        yield* store.add("operator", JSON.stringify(operator));
        const result = yield* provisionFromFlags(flags);
        expect(result.did).toBe(flags.did);
        expect(yield* fs.readFileString(`${state}/retired.json`)).toBe(overlay);
        conflict = refused;

        if (refused) {
          yield* provisionAndRestore(flags).pipe(Effect.flip);
          expect(yield* fs.readFileString(`${state}/retired.json`)).toBe(
            overlay
          );
        } else {
          expect(yield* provisionAndRestore(flags)).toEqual(result);
          expect(yield* directory.retired).toEqual({});
        }

        expect(yield* fs.readFileString(identities)).toBe("{}\n");
      }).pipe(
        Effect.provide(memorySecretStoreLayer),
        Effect.provideService(Directory, directory),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              HOME: state,
              RAT_KING_DOCUMENTS: docs,
              RAT_KING_ENDPOINT: "https://mailbox.example.invalid",
              RAT_KING_OPERATOR_IDENTITY: "operator",
              RAT_KING_SERVICE_DID: "did:web:mailbox.example.invalid",
            })
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
