/* oxlint-disable typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { Effect, Layer, Option, Schema } from "effect";

import { Caller } from "./caller.ts";
import { failure } from "./failure.ts";
import type { PublicDocument } from "./issuer-policy.ts";
import type { IssuerStore } from "./issuer-store.ts";
import {
  DocumentRegistry,
  issuerHandlers,
  issuerRoute,
  RetirementRegistry,
} from "./issuer.ts";
import type { IssuerPolicy } from "./issuer.ts";
import { Retirement } from "./store.ts";
import { trafficDid } from "./traffic-store.ts";
import type { Mailbox } from "./worker.ts";

interface IssuerMailboxes {
  readonly getByName: (
    did: string
  ) => Pick<
    Mailbox,
    | "storeDocument"
    | "unretire"
    | "retirement"
    | "standing"
    | "repoint"
    | "retire"
  >;
}

const mailboxCall = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => failure("MailboxUnavailable", 503),
    try: call,
  });

export const routeIssuer = (input: {
  readonly request: XrpcRequest;
  readonly caller: string;
  readonly mailboxes: IssuerMailboxes;
  readonly store: Layer.Layer<IssuerStore>;
  readonly policy: IssuerPolicy;
}) => {
  const { request, caller, mailboxes, store, policy } = input;

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
            mailboxes
              .getByName(document.id)
              .storeDocument(JSON.stringify(document)),
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
      clear: (did) => mailboxCall(() => mailboxes.getByName(did).unretire()),
      current: Effect.fn("RetirementRegistry.current")(function* current(
        did: string
      ) {
        const json = yield* mailboxCall(() =>
          mailboxes.getByName(did).retirement()
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
          mailboxes.getByName(did).standing()
        );

        return standing.retirement === undefined
          ? {
              exists: standing.exists,
              leaseExpiresAt: standing.leaseExpiresAt,
            }
          : {
              exists: standing.exists,
              leaseExpiresAt: standing.leaseExpiresAt,
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
          mailboxes.getByName(did).repoint(successor, updatedAt)
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
        )(json).pipe(Effect.mapError(() => failure("MailboxUnavailable", 503)));
      }),
      retire: Effect.fn("RetirementRegistry.retire")(
        function* retire(did, retirement, holderMayRetire) {
          if (did === trafficDid) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          const outcome = yield* mailboxCall(() =>
            mailboxes
              .getByName(did)
              .retire(
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

  return issuerRoute(request).pipe(
    Effect.provide(
      issuerHandlers(policy).pipe(
        Layer.provide(store),
        Layer.provide(registry),
        Layer.provide(retirements),
        Layer.provide(Layer.succeed(Caller, { did: caller }))
      )
    )
  );
};
