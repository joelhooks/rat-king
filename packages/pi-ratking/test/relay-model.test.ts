/* oxlint-disable typescript/promise-function-async -- fast-check model command Promise boundary. */
import { it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { openRelay } from "../src/relay.ts";
import type { RelayEntryValue } from "../src/relay.ts";

const Step = Schema.Struct({
  event: Schema.Literals([
    "inbound",
    "handled",
    "failed",
    "advance",
    "restart",
  ]),
  id: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 })),
  minutes: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 0 })),
  staff: Schema.Boolean,
  verified: Schema.Boolean,
});

interface Model {
  now: number;
  pending: Map<string, number>;
  terminal: Set<string>;
  injected: Map<string, number>;
  forwarded: Map<string, number>;
}

const count = (map: Map<string, number>, id: string) =>
  map.set(id, (map.get(id) ?? 0) + 1);

it.effect.prop(
  "relay model: completed-command restarts recover, fallback waits, verified staff bypasses; copy injects and forwards",
  [Schema.Literals(["front", "copy"]), Step, Schema.Array(Step)],
  ([mode, seed, steps]) =>
    Effect.gen(function* modelProof() {
      const context = yield* Effect.context();
      let now = 0;
      let saved: readonly RelayEntryValue[] = [];
      const injected = new Map<string, number>();
      const forwarded = new Map<string, number>();

      const build = () =>
        openRelay(
          { fallbackMinutes: 10, mode, name: "desk", to: "desk/ea" },
          {
            inject: (inbound) =>
              Effect.sync(() => {
                count(injected, inbound.id);
              }),
            load: Effect.sync(() => saved),
            now: Effect.sync(() => now),
            save: (entries) =>
              Effect.sync(() => {
                saved = structuredClone(entries);
              }),
          }
        );

      let relay = yield* build();
      let arrivals = 0;

      const recoverModel = (model: Model) => {
        for (const [id, due] of model.pending) {
          if (due <= model.now) {
            count(model.injected, id);
            model.pending.delete(id);
            model.terminal.add(id);
          }
        }
      };

      const command = (
        step: typeof Step.Type
      ): AsyncCommand<Model, object> => ({
        check: () => true,
        run: (model) => {
          const operation = Effect.gen(function* runCommand() {
            const id = `mail-${step.id}`;

            if (step.event === "inbound") {
              const bypass = step.staff && step.verified;

              const actualId =
                bypass || mode === "copy" ? `arrival-${(arrivals += 1)}` : id;

              const record = yield* relay.receive(
                {
                  body: "body",
                  cc: false,
                  did: "did:web:sender.example.invalid",
                  from: step.staff ? "desk/ea" : "sender",
                  id: actualId,
                  kind: "message",
                  label: Option.none(),
                  replyTo: Option.none(),
                  summary: Option.none(),
                  verified: step.verified,
                },
                false,
                step.verified,
                now
              );

              if (Option.isSome(record)) {
                count(forwarded, actualId);
              }

              if (bypass) {
                count(model.injected, actualId);
              } else if (mode === "copy") {
                count(model.injected, actualId);
                count(model.forwarded, actualId);
              } else if (
                !model.pending.has(actualId) &&
                !model.terminal.has(actualId)
              ) {
                model.pending.set(actualId, now + 600_000);
                count(model.forwarded, actualId);
              }
            } else if (step.event === "advance") {
              now += step.minutes * 60_000;
              model.now = now;
            } else if (step.event === "restart") {
              relay = yield* build();
              recoverModel(model);
            } else if (step.event === "handled") {
              yield* relay.handled(id);

              if (model.pending.delete(id)) {
                model.terminal.add(id);
              }
            } else {
              yield* relay.failed(id);

              if (model.pending.delete(id)) {
                count(model.injected, id);
                model.terminal.add(id);
              }
            }

            expect(injected).toEqual(model.injected);
            expect(forwarded).toEqual(model.forwarded);
            expect([...model.injected.values()].every((n) => n === 1)).toBe(
              true
            );
          });

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check reuses the test context.
          return Effect.runPromiseWith(context)(operation);
        },
        toString: () => JSON.stringify(step),
      });

      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({
            model: {
              forwarded: new Map(),
              injected: new Map(),
              now: 0,
              pending: new Map(),
              terminal: new Set<string>(),
            },
            real: {},
          }),
          [
            command({ ...seed, event: "inbound", staff: false }),
            command({ ...seed, event: "advance", minutes: 10 + seed.minutes }),
            command({ ...seed, event: "restart" }),
            ...steps.map(command),
          ]
        )
      );
      now += 600_001;
      yield* relay.recover(now);
      expect(saved.every((entry) => entry.state !== "pending")).toBe(true);
    }),
  { arbitrary: { runs: 150 } }
);
