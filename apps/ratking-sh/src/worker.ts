import * as Cloudflare from "@alchemy.run/cloudflare";
import { signatures } from "@rat-king/lexicon/webcrypto";
import { Config, Effect, Layer, Option, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { Directory } from "./authority.ts";
import ContactSession, { publicDesk, trustLayer } from "./contact-session.ts";
import DeskPeon from "./desk-peon.ts";
import { handleEdge } from "./http.ts";
import { Issuer, issuerConfig } from "./identity/admin.ts";
import { identityLive } from "./identity/cloudflare.ts";
import { identityZone } from "./identity/names.ts";
import { identityRouter } from "./identity/router.ts";
import { PublicDesk } from "./policy.ts";

interface EdgeEnvironment {
  RATKING_COMMIT: string;
  RATKING_IDENTITY_ISSUER?: string;
  RATKING_PUBLIC_DESK: string;
  RATKING_TRUST_DIRECTORY?: string;
}

export default class RatKingEdge extends Cloudflare.Worker<RatKingEdge>()(
  "RatKingEdge",
  Effect.gen(function* edgeProperties() {
    const desk = yield* Schema.decodeEffect(PublicDesk)(yield* publicDesk);

    const directory = yield* Config.option(
      Config.String("RATKING_TRUST_DIRECTORY")
    );

    const commit = yield* Config.String("RATKING_COMMIT");
    yield* Schema.decodeEffect(
      Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
    )(commit);

    const env: EdgeEnvironment = {
      RATKING_COMMIT: commit,
      RATKING_PUBLIC_DESK: desk,
    };

    if (Option.isSome(directory)) {
      yield* Schema.decodeEffect(Schema.fromJsonString(Directory))(
        directory.value
      );
      env.RATKING_TRUST_DIRECTORY = directory.value;
    }

    const issuer = yield* issuerConfig;

    if (Option.isSome(issuer)) {
      env.RATKING_IDENTITY_ISSUER = JSON.stringify(issuer.value);
    }

    return {
      compatibility: { date: "2026-07-28" },
      env,
      main: import.meta.url,
      workersDev: true,
    };
  }).pipe(Effect.orDie),
  Effect.gen(function* edgeWorker() {
    const contacts = yield* ContactSession;
    yield* DeskPeon;
    const desk = yield* publicDesk;
    const routeIdentity = yield* identityRouter;

    const throttle = yield* Cloudflare.RateLimit("MCP_PER_IP", {
      namespaceId: "41001",
      simple: { limit: 30, period: 60 },
    });

    return {
      fetch: Effect.gen(function* fetch() {
        const incoming = yield* HttpServerRequest.HttpServerRequest;

        const request = yield* HttpServerRequest.toWeb(incoming).pipe(
          Effect.orDie
        );

        const env = yield* Cloudflare.WorkerEnvironment;
        const configured: unknown = env.RATKING_IDENTITY_ISSUER;

        const issuer =
          configured === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Issuer))(
                configured
              );

        const identity = yield* routeIdentity({
          issuer,
          request,
          zone: identityZone,
        });

        if (Option.isSome(identity)) {
          return HttpServerResponse.fromWeb(identity.value);
        }

        return HttpServerResponse.fromWeb(
          yield* handleEdge(request, {
            desk,
            forwardContact: (id, forwarded) => {
              const headers = new Headers(forwarded.headers);
              headers.set("x-ratking-contact-session", id);

              return contacts
                .getByName(id)
                .fetch(
                  HttpServerRequest.fromWeb(new Request(forwarded, { headers }))
                )
                .pipe(Effect.map(HttpServerResponse.toWeb), Effect.orDie);
            },
            // @effect-diagnostics-next-line cryptoRandomUUID:off cryptoRandomUUIDInEffect:off -- Cloudflare adapter creates an opaque, unguessable external session id.
            freshId: Effect.sync(() => crypto.randomUUID()),
            limit: (key) =>
              throttle.limit({ key }).pipe(
                Effect.map((result) => result.success),
                Effect.orDie
              ),
          }).pipe(Effect.provide(trustLayer))
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        identityLive,
        signatures,
        Cloudflare.Workers.RateLimitBinding
      )
    )
  )
) {}
