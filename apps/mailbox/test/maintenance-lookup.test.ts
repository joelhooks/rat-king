import { it } from "@effect/vitest";
import { Effect, Fiber, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { Data } from "../../../packages/lexicon/src/runtime.ts";
import { Transport } from "../../../packages/lexicon/src/transport.ts";
import type { Response } from "../../../packages/lexicon/src/transport.ts";
import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";
import { AgentName } from "../../../packages/ratking-client/src/name.ts";
import { findMaintenanceRecipient } from "../../../stacks/nest/maintenance-lookup.ts";

it.effect.prop(
  "only exhausted or exactly retired results are authoritative misses",
  [AgentName],
  ([name]) =>
    Effect.gen(function* results() {
      const peer = yield* identity("did:web:desk.example.invalid");

      const doc = yield* document(peer).pipe(
        Effect.flatMap(Schema.encodeEffect(Data))
      );

      const row = { did: peer.did, document: doc, name };
      const decoy = { ...row, name: `${name}-copy` };

      const cases = [
        { expected: null, reply: () => ({ names: [decoy] }) },
        {
          expected: null,
          reply: () => ({ names: [{ ...row, status: "retired" }] }),
        },
        {
          expected: "invalid",
          reply: () => ({
            names: [{ ...row, did: "did:web:other.example.invalid" }],
          }),
        },
        { expected: "invalid", reply: () => ({ names: [row, row] }) },
        { expected: "invalid", reply: () => ({ names: "wrong shape" }) },
        {
          calls: 2,
          expected: "invalid",
          reply: () => ({ cursor: "stalled", names: [decoy] }),
        },
        {
          calls: 4,
          expected: "invalid",
          reply: (page: number) => ({ cursor: `page-${page}`, names: [decoy] }),
        },
      ];

      for (const { calls, expected, reply } of cases) {
        let pages = 0;

        const transport = Transport.of({
          request: () =>
            Effect.sync((): Response => {
              pages += 1;

              return { body: reply(pages), kind: "json", status: 200 };
            }),
        });

        const result = yield* Effect.result(
          findMaintenanceRecipient(name)
        ).pipe(Effect.provideService(Transport, transport));

        if (expected === null) {
          expect(result).toEqual(Result.succeed(null));
        } else {
          expect(Result.isFailure(result)).toBe(true);
        }

        expect(pages).toBe(calls ?? 1);
      }
    }),
  { arbitrary: { runs: 3 } }
);

it.effect.prop(
  "a directory request that never settles is unavailable by the overall deadline",
  [AgentName],
  ([name]) =>
    Effect.gen(function* timeout() {
      const fiber = yield* findMaintenanceRecipient(name).pipe(
        Effect.result,
        Effect.provideService(
          Transport,
          Transport.of({ request: () => Effect.never })
        ),
        Effect.forkChild
      );

      yield* TestClock.adjust("4 seconds");
      const result = yield* Fiber.join(fiber);

      expect(Result.isFailure(result)).toBe(true);
    }),
  { arbitrary: { runs: 3 } }
);
