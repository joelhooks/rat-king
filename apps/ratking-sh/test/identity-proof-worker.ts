import * as Cloudflare from "@alchemy.run/cloudflare";
import { signatures } from "@rat-king/lexicon/webcrypto";
import { Context, Effect, Layer, Option } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { trustLayer } from "../src/contact-session.ts";
import { handleEdge } from "../src/http.ts";
import { issuerFromBinding } from "../src/identity/admin.ts";
import { identityLive } from "../src/identity/cloudflare.ts";
import { identityZone } from "../src/identity/names.ts";
import { identityRouter } from "../src/identity/router.ts";

export const ProofIssuer = Context.Reference("IdentityProofIssuer", {
  defaultValue: (): string | undefined => undefined,
});

export default class IdentityProofWorker extends Cloudflare.Worker<IdentityProofWorker>()(
  "IdentityProofWorker",
  ProofIssuer.pipe(
    Effect.map((issuer) => ({
      env: issuer === undefined ? {} : { RATKING_IDENTITY_ISSUER: issuer },
      main: import.meta.url,
    }))
  ),
  Effect.gen(function* proofWorker() {
    const routeIdentity = yield* identityRouter;

    return {
      fetch: Effect.gen(function* fetch() {
        const env = yield* Cloudflare.WorkerEnvironment;

        const issuer = yield* issuerFromBinding(env.RATKING_IDENTITY_ISSUER);

        const incoming = yield* HttpServerRequest.HttpServerRequest;
        const request = yield* HttpServerRequest.toWeb(incoming);

        const response = yield* routeIdentity({
          issuer,
          request,
          zone: identityZone,
        });

        if (Option.isSome(response)) {
          return HttpServerResponse.fromWeb(response.value);
        }

        return HttpServerResponse.fromWeb(
          yield* handleEdge(request, {
            desk: "lobby",
            forwardContact: () =>
              Effect.die("Contact session not available in identity proof"),
            freshId: Effect.die(
              "Contact session not available in identity proof"
            ),
            limit: () => Effect.succeed(false),
          }).pipe(Effect.provide(trustLayer))
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.merge(identityLive, signatures)))
) {}
