// @effect-diagnostics globalFetch:off -- Owned loopback test transport.
/* oxlint-disable typescript/promise-function-async -- Lazy HTTP adapters. */
import { clientLayer } from "@rat-king/lexicon/mailbox-client";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Transport } from "@rat-king/lexicon/transport";
import type {
  Request as XrpcRequest,
  Response as XrpcResponse,
} from "@rat-king/lexicon/transport";
import { TransportFailure } from "@rat-king/lexicon/transport-failure";
import { Clock, Effect, Layer, Schema } from "effect";

import { base64url, serviceToken } from "../src/auth.ts";
import { io } from "./celld.ts";

export const httpClient = (baseUrl: string, issuer: string, key: CryptoKey) =>
  clientLayer.pipe(
    Layer.provide(
      Layer.succeed(Transport, {
        request: Effect.fn("Test.httpTransport")(
          function* request(input: XrpcRequest) {
            const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

            const token = yield* serviceToken(
              {
                aud: "did:web:service.example#mailbox",
                exp: now + 60,
                iat: now,
                iss: issuer,
                jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
                lxm: input.nsid,
              },
              key
            );

            const url = new URL(`/xrpc/${input.nsid}`, baseUrl);

            const params = yield* Schema.decodeUnknownEffect(
              Schema.Record(
                Schema.String,
                Schema.Union([Schema.String, Schema.Int])
              )
            )(input.params ?? {});

            for (const [name, value] of Object.entries(params)) {
              url.searchParams.set(name, String(value));
            }

            const options: RequestInit = {
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              method: input.method,
            };

            if (input.input !== undefined) {
              options.body = JSON.stringify(input.input);
            }

            const response = yield* io(() => fetch(url, options));

            if (response.status === 204) {
              return {
                body: "",
                kind: "text",
                status: 204,
              } satisfies XrpcResponse;
            }

            const body = yield* Schema.decodeUnknownEffect(
              Schema.toEncoded(Runtime.Data)
            )(yield* io(() => response.json()));

            return {
              body,
              kind: "json",
              status: response.status,
            } satisfies XrpcResponse;
          },
          Effect.mapError(
            () =>
              new TransportFailure({
                cause: undefined,
                reason: "HTTP transport failed",
              })
          )
        ),
      })
    )
  );
