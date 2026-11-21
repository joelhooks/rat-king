/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";

import type { Bindings } from "./bindings.ts";
import { Caller } from "./caller.ts";
import { DeskSnapshot, DeskStore, deskStore } from "./desk-store.ts";
import { DeskRegistry, deskHandlers, deskRoute } from "./desk.ts";
import { didAllowlist } from "./documents.ts";
import { failure } from "./failure.ts";
import { issuerInstance } from "./issuer-object.ts";

const SnapshotJson = Schema.fromJsonString(DeskSnapshot);

export class Desk extends DurableObject<Bindings> {
  private readonly store;
  private readonly desk: string;
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const desk = ctx.id.name;

    if (desk?.startsWith("did:web:") !== true) {
      throw failure("Forbidden", 403);
    }

    this.desk = desk;
    this.store = deskStore({
      exec: (query: string, ...values: readonly (string | number)[]) =>
        ctx.storage.sql.exec(query, ...values),
      transaction: <A>(operation: () => A) =>
        ctx.storage.transactionSync(operation),
    });
  }

  route(request: XrpcRequest, caller: string) {
    const { env } = this;

    const registry = Layer.succeed(
      DeskRegistry,
      DeskRegistry.of({
        parent: Effect.fn("DeskRegistry.parent")(function* parent(
          destination: string
        ) {
          const issuers = env.ISSUER;

          return issuers === undefined
            ? undefined
            : yield* Effect.tryPromise({
                catch: () => failure("MailboxUnavailable", 503),
                try: () =>
                  issuers.getByName(issuerInstance).deskParent(destination),
              });
        }),
        snapshot: Effect.fn("DeskRegistry.snapshot")(function* snapshot(
          did: string,
          atSeq: number
        ) {
          const desks = env.DESK;

          if (desks === undefined) {
            return yield* Effect.fail(failure("MailboxUnavailable", 503));
          }

          const json = yield* Effect.tryPromise({
            catch: () => failure("MailboxUnavailable", 503),
            try: () => desks.getByName(did).snapshot(atSeq),
          });

          if (json === "InvalidRequest") {
            return yield* Effect.fail(
              failure("InvalidRequest", 400, "atSeq is beyond the desk's head")
            );
          }

          return yield* Schema.decodeUnknownEffect(SnapshotJson)(json).pipe(
            Effect.mapError(() => failure("MailboxUnavailable", 503))
          );
        }),
      })
    );

    return Effect.runPromise(
      deskRoute(request).pipe(
        Effect.provide(
          deskHandlers(this.desk, didAllowlist(env.OPERATOR_DIDS)).pipe(
            Layer.provide(this.store),
            Layer.provide(registry),
            Layer.provide(Layer.succeed(Caller, { did: caller }))
          )
        )
      )
    );
  }

  snapshot(atSeq: number) {
    return Effect.runPromise(
      DeskStore.use((store) =>
        store.transaction((tx) => tx.snapshot(atSeq))
      ).pipe(
        Effect.map(Schema.encodeSync(SnapshotJson)),
        Effect.catchTag("XrpcFailure", (error) => Effect.succeed(error.error)),
        Effect.provide(this.store)
      )
    );
  }
}
