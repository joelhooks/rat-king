/* oxlint-disable typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";

import type { Bindings } from "./bindings.ts";
import { Caller } from "./caller.ts";
import { didAllowlist } from "./documents.ts";
import { failure } from "./failure.ts";
import type { PublicDocument } from "./issuer-policy.ts";
import { IssuerStore, issuerStore } from "./issuer-store.ts";
import {
  DocumentRegistry,
  issuerConfig,
  issuerHandlers,
  issuerRoute,
  RetirementRegistry,
} from "./issuer.ts";
import { Retirement } from "./store.ts";
import { trafficDid } from "./traffic-store.ts";

export const issuerInstance = "issuer";

const mailboxCall = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => failure("MailboxUnavailable", 503),
    try: call,
  });

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

    const retirements = Layer.succeed(
      RetirementRegistry,
      RetirementRegistry.of({
        clear: (did) =>
          mailboxCall(() => env.MAILBOX.getByName(did).unretire()),
        current: Effect.fn("RetirementRegistry.current")(function* current(
          did: string
        ) {
          const json = yield* mailboxCall(() =>
            env.MAILBOX.getByName(did).retirement()
          );

          return json === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(Retirement)
              )(json).pipe(
                Effect.mapError(() => failure("MailboxUnavailable", 503))
              );
        }),
        presence: Effect.fn("RetirementRegistry.presence")(function* presence(
          did: string
        ) {
          const standing = yield* mailboxCall(() =>
            env.MAILBOX.getByName(did).standing()
          );

          return standing.retirement === undefined
            ? { exists: standing.exists }
            : {
                exists: standing.exists,
                retirement: yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(Retirement)
                )(standing.retirement).pipe(
                  Effect.mapError(() => failure("MailboxUnavailable", 503))
                ),
              };
        }),
        repoint: Effect.fn("RetirementRegistry.repoint")(function* repoint(
          did: string,
          successor: string,
          updatedAt: number
        ) {
          const json = yield* mailboxCall(() =>
            env.MAILBOX.getByName(did).repoint(successor, updatedAt)
          );

          const refusal = Schema.decodeUnknownOption(
            Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
          )(json);

          if (Option.isSome(refusal)) {
            return yield* refusal.value.error === "NotRetired"
              ? failure("NotRetired", 409)
              : failure("MailboxUnavailable", 503);
          }

          return yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Retirement)
          )(json).pipe(
            Effect.mapError(() => failure("MailboxUnavailable", 503))
          );
        }),
        retire: Effect.fn("RetirementRegistry.retire")(
          function* retire(did, retirement, holderMayRetire) {
            if (did === trafficDid) {
              return yield* Effect.fail(failure("Forbidden", 403));
            }

            const outcome = yield* mailboxCall(() =>
              env.MAILBOX.getByName(did).retire(
                Schema.encodeSync(Schema.fromJsonString(Retirement))(
                  retirement
                ),
                holderMayRetire
              )
            );

            if (outcome === "NameNotFound") {
              return yield* Effect.fail(failure("NameNotFound", 404));
            }

            const leaseLive = Schema.decodeUnknownOption(
              Schema.fromJsonString(
                Schema.Struct({
                  error: Schema.Literal("LeaseLive"),
                  message: Schema.String,
                })
              )
            )(outcome);

            if (Option.isSome(leaseLive)) {
              return yield* failure("LeaseLive", 409, leaseLive.value.message);
            }

            if (outcome !== "retired") {
              return yield* Effect.fail(failure("MailboxUnavailable", 503));
            }

            return yield* Effect.void;
          }
        ),
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
            Layer.provide(retirements),
            Layer.provide(Layer.succeed(Caller, { did: caller }))
          )
        )
      )
    );
  }
}
