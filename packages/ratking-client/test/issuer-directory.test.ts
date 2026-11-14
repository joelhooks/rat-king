import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import { Identity } from "@rat-king/mailbox-client";
import { Effect, Layer, Match, Option, Redacted, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Settings } from "../src/config.ts";
import { Directory } from "../src/directory.ts";
import { Issuer, issuerLayer } from "../src/issuer.ts";
import { SecretStore } from "../src/secrets.ts";

it.effect.prop(
  "retired directory rows cross the signed client boundary and refusals retain method, status and detail",
  [Schema.Literals(["retired", "refused", "malformed"])],
  ([mode]) =>
    Effect.gen(function* proof() {
      const host = yield* identity("did:web:host.example.invalid");
      const publicDocument = yield* document(host);
      const encodedDocument = yield* Schema.encodeEffect(Identity)(host);

      const decoded = yield* Schema.decodeUnknownEffect(ListNames.Output)({
        names: [
          {
            did: host.did,
            document: publicDocument,
            name: "alpha",
            status: "retired",
          },
        ],
      });

      const body = yield* Schema.encodeEffect(ListNames.Output)(decoded);

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          expect(url.pathname).toBe(ListNames.Method.path);
          expect(url.searchParams.get("status")).toBe("retired");
          expect(url.searchParams.get("limit")).toBe("1");

          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              Match.value(mode).pipe(
                Match.when("retired", () => body),
                Match.when("refused", () => ({
                  error: "MailboxUnavailable",
                  message: "Retry this directory page",
                })),
                Match.when("malformed", () => ({ names: [{}] })),
                Match.exhaustive
              ),
              { status: mode === "refused" ? 503 : 200 }
            )
          );
        })
      );

      const result = yield* Issuer.use((issuer) =>
        issuer.directory({ limit: 1, status: "retired" })
      ).pipe(
        Effect.result,
        Effect.provide(
          issuerLayer.pipe(
            Layer.provide(NodeServices.layer),
            Layer.provide(Layer.mock(Directory, {})),
            Layer.provide(
              Layer.mock(SecretStore, {
                lease: () =>
                  Effect.succeed(
                    Redacted.make(JSON.stringify(encodedDocument))
                  ),
              })
            ),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
            Layer.provide(
              Layer.succeed(
                Settings,
                Settings.of({
                  askTimeoutMs: 1000,
                  didTemplate: "did:web:{agent}.example.invalid",
                  directory: "unused",
                  documents: [],
                  encrypt: false,
                  endpoint: "https://mailbox.example.invalid",
                  issuer: Option.some({
                    endpoint: "https://issuer.example.invalid",
                    host: "test-identity",
                  }),
                  refuse: [],
                  relays: [],
                  reserved: {},
                  secretsCommand: "unused",
                  serviceDid: "did:web:mailbox.example.invalid",
                  state: "unused",
                })
              )
            )
          )
        )
      );

      if (mode === "retired") {
        expect(Result.isSuccess(result)).toBe(true);

        if (Result.isSuccess(result)) {
          expect(result.success.names[0]?.status).toBe("retired");
        }
      } else {
        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(result.failure.reason).toContain(ListNames.Method.nsid);
          expect(result.failure.reason).toContain(
            mode === "refused" ? "HTTP 503" : "HTTP 200"
          );
          expect(result.failure.reason).toContain(
            mode === "refused"
              ? "MailboxUnavailable: Retry this directory page"
              : "invalid body"
          );
        }
      }
    })
);
