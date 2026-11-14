import { it } from "@effect/vitest";
import * as Retired from "@rat-king/lexicon/identity.listRetired";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Transport } from "@rat-king/lexicon/transport";
import { Clock, Effect, Fiber, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { readRetirements } from "../../../packages/mailbox-client/src/retirements.ts";
import { staticResolver } from "../src/auth.ts";
import { Caller } from "../src/caller.ts";
import { IssuerStore, issuerStore } from "../src/issuer-store.ts";
import {
  DocumentRegistry,
  issuerHandlers,
  issuerRoute,
  RetirementRegistry,
} from "../src/issuer.ts";
import { testStoreFor } from "./helpers.ts";

it.effect.prop(
  "real issuer scans validate in parallel, preserve cursor order, prune stale projections and have a 90s total budget",
  {
    allStale: Schema.Boolean,
    count: Schema.Int.check(Schema.isBetween({ maximum: 210, minimum: 201 })),
  },
  ({ allStale, count }) =>
    Effect.gen(function* scanProof() {
      const operator = "did:web:operator.invalid";
      const storage = yield* testStoreFor("did:web:issuer.invalid");
      const storeLayer = issuerStore(storage.sql);
      const store = yield* IssuerStore.pipe(Effect.provide(storeLayer));

      const rows = Array.from({ length: count }, (_, index) => ({
        by: operator,
        did: `did:web:reader-${index}.invalid`,
        name: `reader-${String(index).padStart(3, "0")}`,
        retiredAt: index,
      }));

      yield* store.transaction((tx) => {
        for (const row of rows) {
          tx.retire(row);
        }
      });
      let active = 0;
      let peak = 0;

      const current = new Map(
        rows
          .filter((_, index) => !allStale && index % 7 !== 0)
          .map((row) => [row.did, row])
      );

      const registry = Layer.succeed(
        RetirementRegistry,
        RetirementRegistry.of({
          clear: () => Effect.die("unexpected clear"),
          current: (did) =>
            Effect.gen(function* mailboxRead() {
              active += 1;
              peak = Math.max(peak, active);

              return yield* Effect.sleep(
                400 + ((current.get(did)?.retiredAt ?? 0) % 8) * 20
              ).pipe(
                Effect.as(current.get(did)),
                Effect.ensuring(
                  Effect.sync(() => {
                    active -= 1;
                  })
                )
              );
            }),
          presence: () => Effect.die("unexpected presence"),
          repoint: () => Effect.die("unexpected repoint"),
          retire: () => Effect.die("unexpected retire"),
        })
      );

      const handlers = issuerHandlers({
        config: Option.none(),
        operators: [operator],
      }).pipe(
        Layer.provide(storeLayer),
        Layer.provide(registry),
        Layer.provide(staticResolver([])),
        Layer.provide(Layer.succeed(Caller, { did: operator })),
        Layer.provide(
          Layer.succeed(DocumentRegistry, { put: () => Effect.void })
        )
      );

      let pages = 0;

      const transport = Transport.of({
        request: (request) =>
          Effect.gen(function* requestPath() {
            pages += 1;
            expect(request.nsid).toBe(Retired.Method.nsid);
            expect(request.method).toBe("GET");

            const response = yield* issuerRoute(request).pipe(
              Effect.provide(handlers)
            );

            return {
              body: yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.toEncoded(Runtime.Data))
              )(response.body),
              kind: "json" as const,
              status: response.status,
            };
          }).pipe(Effect.orDie),
      });

      const started = yield* Clock.currentTimeMillis;
      let completedAt = started;

      const fiber = yield* readRetirements(transport).pipe(
        Effect.tap(() =>
          Clock.currentTimeMillis.pipe(
            Effect.tap((at) =>
              Effect.sync(() => {
                completedAt = at;
              })
            )
          )
        ),
        Effect.forkScoped
      );

      yield* TestClock.adjust(89_000);
      const listed = yield* Fiber.join(fiber);
      expect(listed).toEqual([...current.values()].map((row) => row.name));
      expect(peak).toBe(8);
      expect(active).toBe(0);
      expect(pages).toBe(3);
      expect(
        yield* store.transaction((tx) =>
          tx.retired("", 1000).map((row) => row.name)
        )
      ).toEqual(listed);
      expect(completedAt - started).toBeGreaterThan(10_000);
    }).pipe(Effect.scoped)
);
