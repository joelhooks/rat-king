/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";

import type { Bindings } from "./bindings.ts";
import { Caller } from "./caller.ts";
import { didAllowlist } from "./documents.ts";
import { failure } from "./failure.ts";
import type { PublicDocument } from "./issuer-policy.ts";
import { issuerStore } from "./issuer-store.ts";
import {
  DocumentRegistry,
  issuerConfig,
  issuerHandlers,
  issuerRoute,
} from "./issuer.ts";
import { trafficDid } from "./traffic-store.ts";

export const issuerInstance = "issuer";

export class Issuer extends DurableObject<Bindings> {
  private readonly store;
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.store = issuerStore({
      exec: (query: string, ...values: readonly (string | number)[]) =>
        ctx.storage.sql.exec(query, ...values),
      transaction: <A>(operation: () => A) =>
        ctx.storage.transactionSync(operation),
    });
  }

  route(request: XrpcRequest, caller: string) {
    const { env } = this;

    const registry = Layer.succeed(
      DocumentRegistry,
      DocumentRegistry.of({
        put: Effect.fn("DocumentRegistry.put")(function* put(
          document: PublicDocument
        ) {
          if (document.id === trafficDid) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          const outcome = yield* Effect.tryPromise({
            catch: () => failure("MailboxUnavailable", 503),
            try: () =>
              env.MAILBOX.getByName(document.id).storeDocument(
                JSON.stringify(document)
              ),
          });

          if (outcome === "DocumentConflict") {
            return yield* Effect.fail(failure("DocumentConflict", 409));
          }

          if (outcome !== "stored") {
            return yield* Effect.fail(failure("MailboxUnavailable", 503));
          }

          return yield* Effect.void;
        }),
      })
    );

    return Effect.runPromise(
      issuerRoute(request).pipe(
        Effect.provide(
          issuerHandlers({
            config: issuerConfig(env.ISSUER_DID_TEMPLATE, env.ISSUER_RESERVED),
            operators: didAllowlist(env.OPERATOR_DIDS),
          }).pipe(
            Layer.provide(this.store),
            Layer.provide(registry),
            Layer.provide(Layer.succeed(Caller, { did: caller }))
          )
        )
      )
    );
  }
}
