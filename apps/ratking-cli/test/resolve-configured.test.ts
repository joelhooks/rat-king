import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { settingsLayer } from "@rat-king/ratking-client/config";
import { directoryLayer } from "@rat-king/ratking-client/directory";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { identity } from "../../../packages/mailbox-client/test/identity.ts";
import { SecretStore } from "../../mailbox/cli/secrets.ts";
import { configuredResolve } from "../src/resolve-command.ts";

const document = (did: string) => ({
  authentication: [],
  id: did,
  keyAgreement: [],
  verificationMethod: [],
});

it.effect(
  "configured resolution uses the local cache and operator transport without modifying the cache",
  () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const config = path.join(root, "pi.json");
      const directory = path.join(root, "directory.json");
      const names = path.join(root, "names.json");
      const out = path.join(root, "out.json");
      const localDid = "did:web:cached.example.test:local";

      const cached = JSON.stringify({
        local: { did: localDid, document: document(localDid) },
      });

      yield* fs.writeFileString(directory, cached);
      yield* fs.writeFileString(names, '["local","fresh","unknown"]');
      yield* fs.writeFileString(
        config,
        JSON.stringify({
          didTemplate: "did:web:example.test:{agent}",
          directory,
          endpoint: "https://pi-endpoint.example.test",
          serviceDid: "did:web:pi-endpoint.example.test",
          state: root,
        })
      );
      const signer = yield* identity("did:web:operator.example.test");
      const calls: string[] = [];

      const http = HttpClient.make((request) => {
        expect(request.method).toBe("GET");
        const url = new URL(request.url);
        expect(url.origin).toBe("https://operator.example.test");
        expect(url.pathname).toBe(
          "/xrpc/sh.mschf.ratking.mailbox.getPeerDocument"
        );

        const did = url.searchParams.get("did") ?? "";
        calls.push(did);
        const missing = did.endsWith(":unknown");

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              missing ? { error: "NotFound" } : { document: document(did) },
              { status: missing ? 404 : 200 }
            )
          )
        );
      });

      const runtime = Layer.mergeAll(
        directoryLayer.pipe(Layer.provideMerge(settingsLayer)),
        Layer.mock(SecretStore, {
          lease: (name) => {
            expect(name).toBe("invented-operator-secret");

            return Effect.succeed(JSON.stringify(signer));
          },
        }),
        Layer.succeed(HttpClient.HttpClient, http)
      ).pipe(
        Layer.provideMerge(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              HOME: root,
              RATKING_CONFIG: config,
              RAT_KING_ENDPOINT: "https://operator.example.test",
              RAT_KING_ISSUER_LABEL: "invented-placement",
              RAT_KING_OPERATOR_IDENTITY: "invented-operator-secret",
              RAT_KING_SERVICE_DID: "did:web:operator.example.test",
            })
          )
        )
      );

      const receipt = yield* configuredResolve(names, out).pipe(
        Effect.provide(runtime)
      );

      expect(receipt).toMatchObject({ resolved: 2, total: 3, unresolved: 1 });
      expect(calls.toSorted()).toEqual([
        "did:web:example.test:fresh",
        "did:web:example.test:unknown",
      ]);
      expect(yield* fs.readFileString(directory)).toBe(cached);
      expect(JSON.parse(yield* fs.readFileString(out))).toMatchObject({
        resolved: {
          fresh: { did: "did:web:example.test:fresh" },
          local: { did: localDid },
        },
        total: 3,
        unresolved: [{ name: "unknown", reason: "unknown-name" }],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide([NodeServices.layer, NodeCrypto.layer])
    )
);
