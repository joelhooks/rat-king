import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as fc from "fast-check";
import { expect } from "vitest";

import { chooseName } from "../src/name.ts";
import { runAction } from "../src/tool.ts";
import { quietSocket } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry(
      Schedule.spaced("1 millis").pipe(
        Schedule.while(({ attempt }) => attempt < 5000)
      )
    )
  );

const StepSchema = Schema.Literals(["wait", "claim", "unblock"]);

type Step = typeof StepSchema.Type;

interface Model {
  attempts: number;
  blocked: boolean;
  live: boolean;
}

interface Real {
  readonly step: (
    step: Step,
    expected: { readonly attempts: number; readonly live: boolean }
  ) => Promise<void>;
}

class Command implements fc.AsyncCommand<Model, Real> {
  readonly step: Step;

  constructor(step: Step) {
    this.step = step;
  }

  check() {
    return this.step.length > 0;
  }

  // @effect-diagnostics-next-line asyncFunction:off -- fast-check AsyncCommand.run requires a Promise.
  async run(model: Model, real: Real) {
    if (this.step === "unblock") {
      model.blocked = false;
    }

    if (this.step === "claim" && !model.live && !model.blocked) {
      model.attempts += 1;
      model.live = true;
    }

    await real.step(this.step, {
      attempts: model.attempts,
      live: model.live,
    });
  }

  toString() {
    return this.step;
  }
}

it.live.prop(
  "a fork cannot touch its parent's lease and a held fork retries only on an explicit claim, and only once the parent's lease is gone",
  [Arbitrary.schema(Schema.Array(StepSchema).check(Schema.isMaxLength(12)))],
  ([steps]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      let attempts = 0;
      let blocked = true;
      const leased = new Map<string, number>();
      const secrets = new Map<string, string>();

      const http = HttpClient.make((request) =>
        Effect.gen(function* serve() {
          const nsid = new URL(request.url).pathname;

          if (
            nsid.endsWith(".acquireLease") &&
            Predicate.isTagged(request.body, "Uint8Array")
          ) {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Acquire.Input)
            )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

            if (input.did.includes("switchboard.review")) {
              attempts += 1;

              if (blocked) {
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ error: "LeaseHeld" }, { status: 409 })
                );
              }
            }

            leased.set(input.did, 1);

            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                lease: {
                  did: input.did,
                  expiresAt: DateTime.formatIso(
                    DateTime.makeUnsafe(
                      (yield* Clock.currentTimeMillis) + 300_000
                    )
                  ),
                  generation: 1,
                  harness: input.harness,
                  leaseId: "3mxcx45mn7sex",
                },
              })
            );
          }

          if (
            nsid.endsWith(".renewLease") &&
            Predicate.isTagged(request.body, "Uint8Array")
          ) {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  did: Schema.String,
                  expiresAt: Schema.String,
                  generation: Schema.Int,
                  leaseId: Schema.String,
                })
              )
            )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                lease: {
                  ...input,
                  harness: {
                    $type: "sh.mschf.ratking.runtime.lease#pi",
                    sessionId: input.did.includes("review") ? "fork" : "parent",
                  },
                },
              })
            );
          }

          if (nsid.endsWith(".resolveLease")) {
            const holder = new URL(request.url).searchParams.get("did") ?? "";

            if (!blocked && holder.includes("switchboard.review")) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ error: "LeaseNotFound" }, { status: 404 })
              );
            }

            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                lease: {
                  did: holder,
                  expiresAt: DateTime.formatIso(
                    DateTime.makeUnsafe(
                      (yield* Clock.currentTimeMillis) + 300_000
                    )
                  ),
                  generation: 1,
                  harness: {
                    $type: "sh.mschf.ratking.runtime.lease#pi",
                    sessionId: "parent",
                  },
                  leaseId: "3mxcx45mn7sey",
                },
              })
            );
          }

          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              nsid.endsWith(".releaseLease")
                ? { released: true }
                : { events: [], throughSeq: 0 }
            )
          );
        })
      );

      yield* Effect.gen(function* parentProof() {
        const parent = yield* RatKing;

        yield* parent.run(
          {
            alive: () => true,
            env: Option.some("switchboard"),
            pane: Option.none(),
            pid: 1,
            session: "parent",
          },
          () => Effect.void
        );
        yield* eventually(
          parent.status.pipe(
            Effect.filterOrFail((status) =>
              ReaderState.$is("Live")(status.reader)
            )
          )
        );

        yield* Effect.gen(function* forkProof() {
          const fork = yield* RatKing;
          expect(fork).not.toBe(parent);

          const choice = chooseName({
            entries: [
              { name: "switchboard", session: "parent", source: "env" },
            ],
            env: Option.none(),
            label: "review",
            parentSession: "parent",
            session: "fork",
          });

          yield* fork.run(
            {
              alive: () => true,
              env: choice.name,
              fork: choice.fork,
              pane: Option.none(),
              parent: choice.parent,
              pid: 2,
              session: "fork",
            },
            () => Effect.void
          );
          yield* eventually(
            fork.status.pipe(
              Effect.filterOrFail((status) =>
                ReaderState.$is("SendOnly")(status.reader)
              )
            )
          );
          expect(attempts).toBe(1);
          const context = yield* Effect.context<RatKing>();

          const step = (action: Step) =>
            Effect.gen(function* runStep() {
              if (action === "unblock") {
                blocked = false;
              }

              if (action === "claim") {
                const before = attempts;

                const wasLive = ReaderState.$is("Live")(
                  (yield* fork.status).reader
                );

                const result = yield* runAction("ratking", "1 second", {
                  action: "claim",
                });

                expect(result.isError).toBe(wasLive || blocked);

                if (!wasLive && !blocked) {
                  yield* eventually(
                    fork.status.pipe(
                      Effect.filterOrFail(
                        (status) =>
                          attempts > before &&
                          (ReaderState.$is("Live")(status.reader) ||
                            ReaderState.$is("SendOnly")(status.reader))
                      )
                    )
                  );
                }
              }

              if (action === "wait") {
                yield* Effect.yieldNow;
              }

              const status = yield* fork.status;

              expect(
                leased.get("did:web:switchboard.agents.example.invalid")
              ).toBe(1);

              return { attempts, live: ReaderState.$is("Live")(status.reader) };
            });

          yield* Effect.promise(
            // @effect-diagnostics-next-line asyncFunction:off -- fast-check asyncModelRun is the Promise model boundary.
            async () => {
              await fc.asyncModelRun(
                () => ({
                  model: { attempts: 1, blocked: true, live: false },
                  real: {
                    // @effect-diagnostics-next-line asyncFunction:off -- The model command awaits the real Effect step before comparing state.
                    step: async (action, expected) => {
                      // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check reuses the owning Effect test context for each command.
                      await Effect.runPromiseWith(context)(
                        step(action).pipe(
                          Effect.tap((actual) =>
                            Effect.sync(() => {
                              expect(actual).toEqual(expected);
                            })
                          ),
                          Effect.asVoid
                        )
                      );
                    },
                  },
                }),
                [
                  new Command("wait"),
                  ...steps.map((action) => new Command(action)),
                  new Command("unblock"),
                  new Command("claim"),
                ]
              );
            }
          );
        }).pipe(
          Effect.provide(
            Layer.fresh(
              Layer.merge(harness(state, http, [], { secrets }), quietSocket)
            )
          )
        );
      }).pipe(
        Effect.provide(
          Layer.merge(harness(state, http, [], { secrets }), quietSocket)
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 }, timeout: 20_000 }
);

it.effect.prop(
  "off never claims a name, mints keys or requests any lease",
  [Arbitrary.schema(Schema.Boolean)],
  ([read]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const secrets = new Map<string, string>();

      const http = HttpClient.make(() =>
        Effect.die("off must not contact mailbox")
      );

      yield* Effect.gen(function* disabled() {
        const ratking = yield* RatKing;

        yield* ratking.run(
          {
            alive: () => true,
            disabled: true,
            env: Option.some("off"),
            pane: Option.none(),
            pid: 1,
            reads: read,
            session: "off",
          },
          () => Effect.void
        );
        const status = yield* ratking.status;

        expect(status.reader._tag).toBe("SendOnly");
        expect(Option.isNone(status.self)).toBe(true);
        expect(secrets.size).toBe(0);
        expect(yield* fs.exists(`${state}/claims.json`)).toBe(false);
      }).pipe(Effect.provide(harness(state, http, [], { secrets })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
