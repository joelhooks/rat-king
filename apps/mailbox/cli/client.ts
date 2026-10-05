// @effect-diagnostics nodeBuiltinImport:off -- Cryptographic nonces at the operator adapter.
import { randomBytes } from "node:crypto";

import * as Runtime from "@rat-king/lexicon/runtime";
import { Transport } from "@rat-king/lexicon/transport";
import { TransportFailure } from "@rat-king/lexicon/transport-failure";
import { Clock, Effect, Layer, Result, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { base64url, serviceToken } from "../src/auth.ts";
import { importSigning } from "./identity.ts";
import type { IdentityValue } from "./identity.ts";

export const transportLayer = (
  endpoint: string,
  audience: string,
  identity: IdentityValue
) =>
  Layer.effect(
    Transport,
    Effect.gen(function* makeTransport() {
      const http = yield* HttpClient.HttpClient;

      const key = yield* importSigning(identity).pipe(
        Effect.mapError(
          () =>
            new TransportFailure({
              cause: null,
              reason: "Cannot import signing key",
            })
        )
      );

      return Transport.of({
        request: Effect.fn("MailboxCli.request")(
          function* requestCall(request) {
            const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
            const nonce = yield* Effect.sync(() => base64url(randomBytes(16)));

            const token = yield* serviceToken(
              {
                aud: audience,
                exp: now + 60,
                iat: now,
                iss: identity.did,
                jti: nonce,
                lxm: request.nsid,
              },
              key
            );

            const url = new URL(
              request.nsid.startsWith("/")
                ? request.nsid
                : `/xrpc/${request.nsid}`,
              endpoint
            );

            if (request.params !== undefined) {
              for (const [name, value] of Object.entries(request.params)) {
                if (
                  Schema.is(Schema.String)(value) ||
                  Schema.is(Schema.Finite)(value) ||
                  Schema.is(Schema.Boolean)(value)
                ) {
                  url.searchParams.set(name, String(value));
                }
              }
            }

            let outgoing = HttpClientRequest.make(request.method)(
              url.href
            ).pipe(HttpClientRequest.bearerToken(token));

            if (request.input !== undefined) {
              outgoing = yield* HttpClientRequest.bodyJson(
                outgoing,
                request.input
              );
            }

            const response = yield* http.execute(outgoing);
            const body = yield* response.text;

            const json = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.toEncoded(Runtime.Data))
            )(body).pipe(Effect.result);

            if (Result.isFailure(json)) {
              return { body, kind: "text", status: response.status } as const;
            }

            return {
              body: json.success,
              kind: "json",
              status: response.status,
            } as const;
          },
          Effect.mapError(
            () =>
              new TransportFailure({
                cause: null,
                reason: "Service-auth HTTP call failed",
              })
          )
        ),
      });
    })
  );
