/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Durable Object RPC methods return the Effect runtime promise directly. */
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";

import { Document } from "./auth.ts";
import type { Bindings } from "./bindings.ts";
import { configuredDocuments, didAllowlist } from "./documents.ts";
import { nameDid } from "./issuer-policy.ts";
import { routeIssuer } from "./issuer-runtime.ts";
import { IssuerStore, issuerStore } from "./issuer-store.ts";
import { issuerConfig } from "./issuer.ts";
import { projectionViews } from "./list-names.ts";
import { SeedBatch } from "./name-state-seed.ts";
import { NameState } from "./name-state.ts";
import { drainTickets } from "./name-tickets.ts";

export { issuerInstance } from "./issuer-policy.ts";

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

  observeStanding(json: string) {
    const state = Schema.decodeSync(Schema.fromJsonString(NameState))(json);

    return Effect.runPromise(
      IssuerStore.use((store) =>
        store.transaction((tx) => tx.observe(state))
      ).pipe(Effect.provide(this.store))
    );
  }

  cacheDirectoryDocument(json: string) {
    const document = Schema.decodeSync(Schema.fromJsonString(Document), {
      onExcessProperty: "error",
    })(json);

    return Effect.runPromise(
      IssuerStore.use((store) =>
        store.transaction((tx) => {
          tx.cacheAuthDocument(document);
        })
      ).pipe(Effect.provide(this.store))
    );
  }

  seedNameState(json: string, caller: string) {
    if (!didAllowlist(this.env.OPERATOR_DIDS).includes(caller)) {
      return Promise.resolve({ status: 403 });
    }

    const batch = Schema.decodeUnknownOption(Schema.fromJsonString(SeedBatch), {
      onExcessProperty: "error",
    })(json);

    if (
      Option.isNone(batch) ||
      batch.value.rows.some(
        ({ document, state }) =>
          document !== undefined && document.id !== state.did
      )
    ) {
      return Promise.resolve({ status: 400 });
    }

    return Effect.runPromise(
      IssuerStore.use((store) =>
        store.transaction((tx) => {
          for (const { document, state } of batch.value.rows) {
            if (document !== undefined) {
              tx.cacheAuthDocument(document);
            }

            tx.observe(state);
          }

          return { status: 200 };
        })
      ).pipe(
        Effect.provide(this.store),
        Effect.catchTag("XrpcFailure", (error) =>
          Effect.succeed({ status: error.status })
        )
      )
    );
  }

  directoryDocument(did: string) {
    return Effect.runPromise(
      IssuerStore.use((store) =>
        store.transaction((tx) => {
          const doc = tx.authDocument(did);

          return doc === undefined ? undefined : JSON.stringify(doc);
        })
      ).pipe(Effect.provide(this.store))
    );
  }

  drainTickets() {
    return Effect.runPromise(
      drainTickets(this.env.MAILBOX).pipe(
        Effect.asVoid,
        Effect.provide(this.store)
      )
    );
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
        views: projectionViews(env.NAME_STATE_VIEWS),
      })
    );
  }
}
