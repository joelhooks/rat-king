/* oxlint-disable typescript/promise-function-async -- fast-check model command Promise boundary. */
import { it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { compactLines } from "../src/message-view.ts";
import { renderInbound } from "../src/payload.ts";
import type { Inbound } from "../src/payload.ts";
import { deliverRelay } from "../src/relay.ts";

const Step = Schema.Struct({
  body: Schema.String,
  event: Schema.Literals(["record", "restart"]),
  from: Schema.Literals(["desk", "imposter"]),
  originalVerified: Schema.Boolean,
  own: Schema.Literals(["desk/ea", "desk", "other"]),
  verified: Schema.Boolean,
});

interface Model {
  deliveries: number;
  remembered: number;
}

it.effect.prop(
  "EA relay model: only verified desk mail reaches the assigned EA, as original mail with a direct reply hint and via marker",
  [Step, Schema.Array(Step)],
  ([seed, steps]) =>
    Effect.gen(function* eaModel() {
      const context = yield* Effect.context();
      const remembered: Inbound[] = [];
      const delivered: Inbound[] = [];

      const config = {
        fallbackMinutes: 10,
        mode: "front",
        name: "desk",
        to: "desk/ea",
      } as const;

      const command = (
        step: typeof Step.Type
      ): AsyncCommand<Model, object> => ({
        check: () => true,
        run: (model) => {
          const operation = Effect.gen(function* applyRecord() {
            if (step.event === "restart") {
              remembered.length = 0;
              model.remembered = 0;

              return;
            }

            const accepted =
              step.own === "desk/ea" && step.from === "desk" && step.verified;

            const id = `original-${model.deliveries}`;

            const projected = yield* deliverRelay(
              config,
              step.own,
              {
                did: "did:web:desk.example.invalid",
                from: step.from,
                id: "relay-envelope",
                record: {
                  $type: "sh.mschf.ratking.relay#message",
                  body: step.body,
                  cc: false,
                  did: "did:web:person.example.invalid",
                  encrypted: true,
                  from: "person",
                  id,
                  kind: "ask",
                  label: "Yaffle",
                  replyTo: null,
                  summary: "Original summary",
                  verified: step.originalVerified,
                },
                replyTo: Option.none(),
                verified: step.verified,
              },
              {
                deliver: (inbound, settled) =>
                  Effect.sync(() => {
                    expect(settled).toBe(false);
                    delivered.push(inbound);
                  }),
                remember: (inbound) =>
                  Effect.sync(() => {
                    remembered.push(inbound);
                  }),
              }
            );

            expect(projected).toBe(accepted);

            if (accepted) {
              model.deliveries += 1;
              model.remembered += 1;
              const original = delivered.at(-1);
              expect(original?.id).toBe(id);
              expect(original?.from).toBe("person");
              expect(original?.verified).toBe(step.originalVerified);
              expect(original?.body).toBe(step.body);
              expect(original?.label).toEqual(Option.some("Yaffle"));
              expect(original?.summary).toEqual(
                Option.some("Original summary")
              );

              if (original === undefined) {
                throw new Error("Missing original");
              }

              const text = renderInbound("intercom", original);
              expect(text).toContain(
                `To reply to person: intercom({ action: "reply", replyTo: "${id}", replyAll: false`
              );
              expect(text).toContain(`action: "handled", replyTo: "${id}"`);

              const compact = compactLines(
                {
                  body: original.body,
                  cc: false,
                  from: original.from,
                  label: "Yaffle",
                  relay: original.relay,
                  verified: original.verified,
                },
                80
              );

              expect(compact[0]).toContain("via desk");
              expect(compact[0]).toContain("Yaffle");
              expect(compact.length).toBeLessThanOrEqual(4);
            }

            expect(delivered).toHaveLength(model.deliveries);
            expect(remembered).toHaveLength(model.remembered);
          });

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check reuses the test context.
          return Effect.runPromiseWith(context)(operation);
        },
        toString: () => JSON.stringify(step),
      });

      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({ model: { deliveries: 0, remembered: 0 }, real: {} }),
          [
            command({
              ...seed,
              event: "record",
              from: "desk",
              own: "desk/ea",
              verified: true,
            }),
            command({
              ...seed,
              event: "record",
              from: "desk",
              own: "desk/ea",
              verified: false,
            }),
            command({
              ...seed,
              event: "record",
              from: "imposter",
              own: "desk/ea",
              verified: true,
            }),
            command({
              ...seed,
              event: "record",
              from: "desk",
              own: "other",
              verified: true,
            }),
            ...steps.map(command),
          ]
        )
      );
    }),
  { arbitrary: { runs: 150 } }
);
