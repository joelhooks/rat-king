/* oxlint-disable typescript/promise-function-async -- Durable Object RPC methods return the Effect runtime promise directly. */
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option } from "effect";

import type { Bindings } from "./bindings.ts";
import { configuredDocuments, didAllowlist } from "./documents.ts";
import { nameDid } from "./issuer-policy.ts";
import { routeIssuer } from "./issuer-runtime.ts";
import { IssuerStore, issuerStore } from "./issuer-store.ts";
import { issuerConfig } from "./issuer.ts";

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

  lookupName(name: string) {
    return Effect.runPromise(
      Effect.gen(function* lookupName() {
        const store = yield* IssuerStore;

        return yield* store.transaction((tx) => tx.binding(name)?.did);
      }).pipe(Effect.provide(this.store))
    );
  }

  deskParent(did: string) {
    const { env } = this;

    return Effect.runPromise(
      IssuerStore.use((store) =>
        store.transaction((tx) => {
          const resolve = (name: string) =>
            tx.binding(name)?.did ??
            Option.getOrUndefined(
              issuerConfig(env.ISSUER_DID_TEMPLATE, env.ISSUER_RESERVED).pipe(
                Option.map(({ didTemplate }) => nameDid(didTemplate, name)),
                Option.filter((candidate) =>
                  configuredDocuments(env).some(({ id }) => id === candidate)
                )
              )
            );

          return Option.getOrUndefined(
            Option.fromNullishOr(tx.parentName(did)).pipe(Option.map(resolve))
          );
        })
      ).pipe(Effect.provide(this.store))
    );
  }

  route(request: XrpcRequest, caller: string) {
    const { env } = this;

    return Effect.runPromise(
      routeIssuer({
        caller,
        mailboxes: env.MAILBOX,
        policy: {
          config: issuerConfig(env.ISSUER_DID_TEMPLATE, env.ISSUER_RESERVED),
          operators: didAllowlist(env.OPERATOR_DIDS),
          staticDids: new Set(configuredDocuments(env).map(({ id }) => id)),
        },
        request,
        store: this.store,
      })
    );
  }
}
