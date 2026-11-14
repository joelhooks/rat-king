import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as RecordRetired from "@rat-king/lexicon/identity.recordRetired";
import * as Register from "@rat-king/lexicon/identity.register";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vitest";

import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";
import { directoryPage } from "../../../packages/pi-ratking/src/directory-page.ts";
import { Settings } from "../../../packages/ratking-client/src/config.ts";
import {
  Directory,
  directoryLayer,
} from "../../../packages/ratking-client/src/directory.ts";
import {
  Issuer,
  issuerLayer,
} from "../../../packages/ratking-client/src/issuer.ts";
import {
  RatKing,
  ratKingLayer,
} from "../../../packages/ratking-client/src/ratking.ts";
import { SecretStore } from "../../../packages/ratking-client/src/secrets.ts";
import { Caller } from "../src/caller.ts";
import { IssuerStore, issuerStore } from "../src/issuer-store.ts";
import {
  DocumentRegistry,
  issuerHandlers,
  issuerRoute,
  RetirementRegistry,
} from "../src/issuer.ts";
import { testStoreFor } from "./helpers.ts";

const operator = "did:web:operator.example.invalid";

const post = (nsid: string, input: XrpcRequest["input"]): XrpcRequest => ({
  input,
  method: "POST",
  nsid,
  params: undefined,
});

it.effect.prop(
  "a command-registered session can appear in local all:true while recordRetired correctly reports unknown until service registration",
  [Schema.Literals(["example/session-a", "example/session-b"])],
  ([name]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      let failOverlayWrites = false;

      const filesystem: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (file, data, options) =>
          failOverlayWrites && file.includes(".retired.json.")
            ? Effect.fail(
                PlatformError.badArgument({
                  description: "Synthetic overlay write failure",
                  method: "writeFileString",
                  module: "FileSystem",
                })
              )
            : fs.writeFileString(file, data, options),
      };

      const peer = yield* identity(
        `did:web:${name.replace("/", ".")}.example.invalid`
      );

      const publicDocument = yield* document(peer);

      const parent = {
        name: "example/parent",
        session: "example-parent-session",
      };

      const database = yield* testStoreFor("did:web:issuer.example.invalid");

      const store = yield* IssuerStore.pipe(
        Effect.provide(issuerStore(database.sql))
      );

      yield* store.transaction((tx) => {
        tx.enroll(operator);
      });

      const server = issuerHandlers({
        config: Option.some({
          didTemplate: "did:web:{agent}.example.invalid",
          reserved: [],
        }),
        operators: [operator],
      }).pipe(
        Layer.provide(Layer.succeed(IssuerStore, store)),
        Layer.provide(Layer.succeed(Caller, { did: operator })),
        Layer.provide(Layer.mock(DocumentRegistry, { put: () => Effect.void })),
        Layer.provide(Layer.mock(RetirementRegistry, {}))
      );

      const route = (request: XrpcRequest) =>
        issuerRoute(request).pipe(Effect.provide(server));

      const client = ratKingLayer.pipe(
        Layer.provideMerge(issuerLayer),
        Layer.provideMerge(directoryLayer),
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
                command: [process.execPath, "-e", "process.exit(0)"],
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
          Layer.merge(
            NodeServices.layer,
            Layer.succeed(FileSystem.FileSystem, filesystem)
          )
        ),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Effect.die("Command issuer must not call service HTTP")
            )
          )
        )
      );

      yield* Effect.gen(function* commandClient() {
        const issuer = yield* Issuer;
        const ratking = yield* RatKing;
        const directory = yield* Directory;
        expect(yield* issuer.ensure(name, publicDocument, parent)).toBe(
          peer.did
        );
        const local = yield* ratking.directory({ all: true });
        expect(local.names.map((entry) => entry.name)).toEqual([name]);
        expect(local.names[0]?.parent).toEqual(parent);
        const original = yield* fs.readFileString(`${state}/directory.json`);
        const resolved = yield* directory.resolve(name);
        const documents = yield* directory.documents;
        const identityList = yield* directory.list;
        expect(yield* directory.importRetired([name, name])).toEqual({
          added: 1,
          already: 1,
        });
        expect(yield* directory.importRetired([name])).toEqual({
          added: 0,
          already: 1,
        });
        yield* directory.record(name, publicDocument, parent);
        expect(yield* ratking.list).toEqual([]);
        const inventory = yield* ratking.directory({ all: true });
        const retired = yield* ratking.directory({ status: "retired" });
        expect(inventory.names.map((entry) => entry.name)).toEqual([name]);
        expect(inventory.names[0]?.status).toBe("retired");
        expect(retired.names).toEqual(inventory.names);
        expect(yield* directory.resolve(name)).toEqual(resolved);
        expect(yield* directory.documents).toEqual(documents);
        expect(yield* directory.list).toEqual(identityList);
        expect(yield* directory.nameOf(peer.did)).toEqual(Option.some(name));
        expect(yield* fs.readFileString(`${state}/directory.json`)).toBe(
          original
        );
        yield* issuer.ensure(name, publicDocument, parent);
        expect((yield* ratking.list).map((entry) => entry.name)).toEqual([
          name,
        ]);
        expect(yield* directory.retired).toEqual({});
        yield* directory.importRetired([name]);
        failOverlayWrites = true;
        expect(yield* issuer.ensure(name, publicDocument, parent)).toBe(
          peer.did
        );
        failOverlayWrites = false;
        expect(Object.hasOwn(yield* directory.retired, name)).toBe(true);
        yield* directory.clearRetired(name);

        const unavailable = yield* issuer
          .directory({ status: "retired" })
          .pipe(Effect.flip);

        expect(unavailable.reason).toBe(
          "Directory status filters require a service issuer"
        );

        for (const all of [false, true]) {
          for (const status of ["live", "idle", "live,retired"]) {
            const refused = yield* ratking
              .directory({ all, status })
              .pipe(Effect.flip);

            expect(refused.reason).toBe(
              "Directory status filters require a service issuer"
            );
          }

          const refused = yield* directoryPage(ratking, {
            all,
            status: "live",
          }).pipe(Effect.flip);

          expect(refused).toMatchObject({
            reason: "Directory status filters require a service issuer",
          });
        }
      }).pipe(Effect.provide(client));
      expect(
        yield* store.transaction((tx) => tx.binding(name))
      ).toBeUndefined();

      const issuerPage = yield* route({
        input: undefined,
        method: "GET",
        nsid: ListNames.Method.nsid,
        params: { all: true },
      });

      const remote = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ListNames.Output)
      )(issuerPage.body);

      expect(remote.names).toEqual([]);

      const before = yield* route(
        post(RecordRetired.Method.nsid, { names: [name] })
      );

      const unknown = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(RecordRetired.Output)
      )(before.body);

      expect(unknown.results).toEqual([{ name, outcome: "unknown" }]);

      const input = yield* Schema.encodeEffect(Register.Input)({
        document: publicDocument,
        name,
        parent,
      });

      const registered = yield* route(post(Register.Method.nsid, input));
      expect(registered.status).toBe(200);
      const binding = yield* store.transaction((tx) => tx.binding(name));
      expect(binding?.did).toBe(peer.did);

      const after = yield* route(
        post(RecordRetired.Method.nsid, { names: [name] })
      );

      const recorded = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(RecordRetired.Output)
      )(after.body);

      expect(recorded.results).toEqual([{ name, outcome: "recorded" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 30_000 }
);
