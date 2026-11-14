import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Settings } from "../src/config.ts";
import { Directory } from "../src/directory.ts";
import { Issuer } from "../src/issuer.ts";
import { RatKing, ratKingLayer } from "../src/ratking.ts";
import { SecretStore } from "../src/secrets.ts";

it.effect.prop(
  "service-issuer listing never consults the host-local retired overlay",
  [Schema.Boolean],
  ([all]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const peer = yield* identity("did:web:example.peer.example.invalid");
      const publicDocument = yield* document(peer);

      const row = {
        did: peer.did,
        document: publicDocument,
        name: "example/peer",
      };

      const page = yield* Schema.decodeUnknownEffect(ListNames.Output)({
        names: [row],
      });

      const client = ratKingLayer.pipe(
        Layer.provide(
          Layer.mock(Issuer, {
            directory: (params) => {
              expect(params.all).toBe(all);

              return Effect.succeed(page);
            },
            names: Effect.succeed([row]),
          })
        ),
        Layer.provide(
          Layer.mock(Directory, {
            list: Effect.succeed([
              { aliases: [], did: peer.did, name: row.name, reserved: false },
            ]),
            retired: Effect.die(
              "Service issuer must not inspect local retirement"
            ),
          })
        ),
        Layer.provide(Layer.mock(SecretStore, {})),
        Layer.provide(
          Layer.succeed(
            Settings,
            Settings.of({
              askTimeoutMs: 1000,
              didTemplate: "did:web:{agent}.example.invalid",
              directory: `${state}/directory.json`,
              documents: [],
              encrypt: false,
              endpoint: "https://mailbox.example.invalid",
              issuer: Option.some({
                endpoint: "https://issuer.example.invalid",
                host: "unused",
              }),
              refuse: [],
              relays: [],
              reserved: {},
              secretsCommand: "unused",
              serviceDid: "did:web:mailbox.example.invalid",
              state,
            })
          )
        ),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("No HTTP expected"))
          )
        ),
        Layer.provide(NodeServices.layer)
      );

      yield* Effect.gen(function* read() {
        const ratking = yield* RatKing;
        expect(yield* ratking.directory({ all })).toEqual(page);
        expect((yield* ratking.list).map((entry) => entry.name)).toEqual([
          row.name,
        ]);
      }).pipe(Effect.provide(client));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
