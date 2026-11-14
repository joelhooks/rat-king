import * as Cloudflare from "@alchemy.run/cloudflare";
import { signatures } from "@rat-king/lexicon/webcrypto";
import { Config, Effect, Layer, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { authority } from "./authority.ts";
import { contactDispatcher } from "./contact-handler.ts";
import { readBody, secure } from "./http.ts";
import { PublicDesk } from "./policy.ts";
import { StoredSession } from "./session.ts";

export const trustLayer = Layer.merge(authority, signatures);

export const publicDesk = Config.String("RATKING_PUBLIC_DESK").pipe(
  Config.withDefault("lobby")
);

export default class ContactSession extends Cloudflare.DurableObject<ContactSession>()(
  "ContactSession",
  Effect.gen(function* contactSessionDefinition() {
    const state = yield* Cloudflare.DurableObjectState;

    const desk = yield* Schema.decodeEffect(PublicDesk)(yield* publicDesk).pipe(
      Effect.orDie
    );

    // @effect-diagnostics-next-line returnEffectInGen:off -- Alchemy separates the resource definition from its per-instance initialization.
    return Effect.gen(function* contactInstance() {
      const dispatch = yield* contactDispatcher(desk, {
        load: state.storage
          .get<typeof StoredSession.Type>("contact")
          .pipe(
            Effect.flatMap((stored) =>
              stored === undefined
                ? Effect.succeed(stored)
                : Schema.decodeEffect(StoredSession)(stored).pipe(Effect.orDie)
            )
          ),
        save: (session) => state.storage.put("contact", session),
      });

      return {
        fetch: Effect.gen(function* fetch() {
          const incoming = yield* HttpServerRequest.HttpServerRequest;

          const request = yield* HttpServerRequest.toWeb(incoming).pipe(
            Effect.orDie
          );

          const body =
            request.method === "POST" ? yield* readBody(request) : "";

          const result = yield* dispatch(
            request,
            body,
            request.headers.get("x-ratking-contact-session") ?? ""
          );

          return HttpServerResponse.fromWeb(secure(result));
        }).pipe(
          Effect.provide(trustLayer),
          Effect.catchTags({
            EdgeFailure: (error) =>
              Effect.succeed(
                HttpServerResponse.text("Invalid or oversized request", {
                  status: error.status,
                })
              ),
            TrustFailure: () =>
              Effect.succeed(
                HttpServerResponse.text("Invalid credential", { status: 401 })
              ),
          }),
          Effect.orDie
        ),
      };
    });
  }).pipe(Effect.orDie)
) {}
