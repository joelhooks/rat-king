import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Match,
  Result,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { identity } from "../../../packages/mailbox-client/test/identity.ts";
import { runRatking } from "../src/main.ts";
import { refreshDocument } from "../src/resolve-command.ts";
import { ResolveError } from "../src/resolve.ts";

it.effect.prop(
  "the real refresh adapter emits fixed tags for bad documents, DID conflicts and remote failures",
  {
    outcome: Schema.Literals([
      "hit",
      "unknown",
      "failed",
      "invalid",
      "mismatch",
      "private",
    ]),
  },
  ({ outcome }) =>
    Effect.gen(function* test() {
      const did = "did:web:example.test:agent";
      const signer = yield* identity("did:web:example.test:operator");

      const http = HttpClient.make((request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toContain(
          "sh.mschf.ratking.mailbox.getPeerDocument"
        );

        const document = {
          authentication: [],
          id: outcome === "mismatch" ? "did:web:wrong.test" : did,
          keyAgreement: [],
          verificationMethod:
            outcome === "private"
              ? [
                  {
                    controller: did,
                    id: `${did}#key`,
                    publicKeyJwk: {
                      crv: "P-256",
                      d: "private-key",
                      kty: "EC",
                      x: "x",
                      y: "y",
                    },
                  },
                ]
              : [],
        };

        const status = Match.value(outcome).pipe(
          Match.when("unknown", () => 404),
          Match.when("failed", () => 503),
          Match.orElse(() => 200)
        );

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              status === 200
                ? { document: outcome === "invalid" ? {} : document }
                : { error: "private-remote-text" },
              { status }
            )
          )
        );
      });

      const own = yield* ownIdentity(signer);

      const client = yield* prepare({
        endpoint: "https://example.test",
        own,
        peers: [],
        serviceDid: "did:web:example.test",
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));

      const result = yield* refreshDocument(client.refresh, did).pipe(
        Effect.result
      );

      if (outcome === "hit") {
        expect(Result.isSuccess(result)).toBe(true);
      } else {
        expect(Result.isFailure(result)).toBe(true);

        const expected = Match.value(outcome).pipe(
          Match.when("unknown", () => "unknown-name"),
          Match.when("failed", () => "refresh-failed"),
          Match.when("mismatch", () => "did-mismatch"),
          Match.orElse(() => "invalid-document")
        );

        if (Result.isFailure(result)) {
          expect(result.failure).toBe(expected);
        }
      }

      expect(JSON.stringify(result)).not.toContain("private-");
    }).pipe(Effect.scoped)
);

it.effect(
  "operator configuration failure publishes nothing and exposes no key or exception details",
  () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();

      const error = yield* runRatking([
        "resolve",
        "--names",
        `${root}/names.json`,
        "--out",
        `${root}/out.json`,
      ]).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        Effect.flip
      );

      expect(Schema.is(ResolveError)(error)).toBe(true);
      expect(error).toMatchObject({ code: "ResolveConfiguration" });
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide([NodeServices.layer, NodeCrypto.layer])
    )
);
