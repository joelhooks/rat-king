/* oxlint-disable typescript/promise-function-async, effect-tests/no-manual-effect-runtime-in-tests -- asyncModelRun bridges commands through the owning test context. */
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Result, Schema } from "effect";
import * as fc from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { stageOwnedUnit } from "../../../stacks/nest/ship-unit-stage.ts";
import { fleetMemoryLimits } from "../../../stacks/nest/stop-memory.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { nodeUnit, sliceUnit, storeUnit } from "../src/service-units.ts";
import { needsUpdate, readUnit, reconcileUnit } from "../src/systemd.ts";
import type { UnitProps } from "../src/systemd.ts";

const Revision = Schema.Int.check(Schema.isBetween({ maximum: 2, minimum: 0 }));

const Cycle = Schema.Struct({
  cascade: Schema.Boolean,
  inputs: Revision,
  known: Schema.Boolean,
  proved: Schema.Boolean,
  reload: Schema.Boolean,
  staged: Schema.Boolean,
  started: Schema.Boolean,
  version: Revision,
});

const props = (
  version: number,
  inputs: number,
  started: boolean
): UnitProps => ({
  home: "/home/example",
  name: "fixture.invalid.service",
  restartOn: [`input-${inputs}`],
  scope: "user",
  sections: [
    { lines: [["ExecStart", `/opt/version-${version}`]], name: "Service" },
  ],
  started,
});

interface Model {
  active: boolean;
  inputs: number;
  known: boolean;
  version: number;
}

const expectedReconciliation = (model: Model, cycle: typeof Cycle.Type) => {
  const liveActive = model.active || cycle.cascade;
  const declarationChanged = model.version !== cycle.version;
  const wrote = declarationChanged && !cycle.staged;
  const unloaded = declarationChanged && cycle.staged && !cycle.reload;

  const coalesced =
    model.known &&
    cycle.known &&
    cycle.cascade &&
    !wrote &&
    !unloaded &&
    cycle.proved;

  const changed =
    !coalesced && (declarationChanged || model.inputs !== cycle.inputs);

  const expected: string[] = [];

  if (cycle.started && !liveActive) {
    expected.push("start");
  }

  if (cycle.started && liveActive && changed) {
    expected.push("restart");
  }

  if (!cycle.started && liveActive) {
    expected.push("stop");
  }

  return { expected, wrote };
};

it.effect.prop(
  "repeated reconciliation starts and stops to declaration, and coalesces only a proven loaded cascade",
  [Arbitrary.schema(Schema.Array(Cycle).check(Schema.isMaxLength(30)))],
  ([cycles]) =>
    Effect.gen(function* reconciliationModel() {
      const context = yield* Effect.context();
      const fake = yield* makeFakeShell();
      let invocation = 0;
      let known = true;

      const shell = {
        ...fake.shell,
        exec: (argv: readonly string[]) =>
          fake.shell.exec(argv).pipe(
            Effect.map((result) => {
              if (
                result.code === 0 &&
                (argv[2] === "start" || argv[2] === "restart")
              ) {
                invocation += 1;
              }

              return argv[2] === "show" && !argv.includes("--value")
                ? {
                    ...result,
                    stdout: `${result.stdout}InvocationID=${known ? `invocation-${invocation}` : ""}\n`,
                  }
                : result;
            })
          ),
      };

      const real = {
        output: yield* reconcileUnit(
          shell,
          props(0, 0, true),
          undefined,
          false
        ),
      };

      const commands: AsyncCommand<Model, typeof real>[] = cycles.map(
        (cycle) => ({
          check: () => true,
          run: (model, actual) =>
            Effect.runPromiseWith(context)(
              Effect.gen(function* step() {
                ({ known } = cycle);
                const next = props(cycle.version, cycle.inputs, cycle.started);

                if (cycle.staged) {
                  yield* stageOwnedUnit(shell, next, { attr: actual.output });

                  if (cycle.reload) {
                    yield* shell.exec(["systemctl", "--user", "daemon-reload"]);
                  }
                }

                if (cycle.cascade) {
                  yield* shell.exec([
                    "systemctl",
                    "--user",
                    "restart",
                    next.name,
                  ]);
                }

                const { expected, wrote } = expectedReconciliation(
                  model,
                  cycle
                );

                const before = (yield* fake.calls()).length;
                actual.output = yield* reconcileUnit(
                  shell,
                  next,
                  actual.output,
                  false,
                  Effect.succeed(cycle.proved)
                );
                const calls = (yield* fake.calls()).slice(before);
                expect(
                  calls
                    .filter(
                      (call) =>
                        call.operation === "exec" &&
                        ["start", "restart", "stop"].includes(
                          call.argv[2] ?? ""
                        )
                    )
                    .map((call) => call.argv[2])
                ).toEqual(expected);
                expect(
                  calls.filter((call) => call.operation === "write")
                ).toHaveLength(wrote ? 1 : 0);
                expect(actual.output.active).toBe(cycle.started);
                expect(actual.output.needDaemonReload).toBe(false);
                expect(actual.output.enabled).toBe(false);
                model.active = cycle.started;
                model.inputs = cycle.inputs;
                model.known = cycle.known;
                model.version = cycle.version;
              })
            ),
          toString: () => JSON.stringify(cycle),
        })
      );

      yield* Effect.promise(() =>
        fc.asyncModelRun(
          () => ({
            model: { active: true, inputs: 0, known: true, version: 0 },
            real,
          }),
          commands
        )
      );
    }),
  { arbitrary: { runs: 100, seed: 31_337 } }
);

const RetryVersion = Schema.Literals([1, 2, 3]);

it.effect(
  "a failed restart preserves the owned declaration for a successful retry",
  () =>
    Effect.gen(function* retryInvariant() {
      const context = yield* Effect.context();

      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(
            fc.constantFrom(...RetryVersion.literals),
            (version) =>
              Effect.runPromiseWith(context)(
                Effect.gen(function* retry() {
                  const fake = yield* makeFakeShell();

                  const initial = yield* reconcileUnit(
                    fake.shell,
                    props(0, 0, true),
                    undefined,
                    false
                  );

                  yield* fake.failStart();
                  const next = props(version, version, true);

                  const failed = yield* reconcileUnit(
                    fake.shell,
                    next,
                    initial,
                    false
                  ).pipe(Effect.result);

                  expect(Result.isFailure(failed)).toBe(true);
                  const bytes = yield* fake.shell.read(initial.path);
                  expect(bytes).toBeDefined();

                  const retried = yield* reconcileUnit(
                    fake.shell,
                    next,
                    initial,
                    false
                  );

                  expect(retried.active).toBe(true);
                  expect(retried.needDaemonReload).toBe(false);
                  expect(retried.sha256).not.toBe(initial.sha256);
                })
              )
          ),
          { numRuns: 20, seed: 31_337 }
        )
      );
    })
);

it.effect.prop(
  "the fleet memory rollout updates the slice and restarts celld once while unchanged weed stays up across readiness changes",
  [Schema.Array(Schema.Int).check(Schema.isMaxLength(5))],
  ([seeds]) =>
    Effect.gen(function* memoryRolloutModel() {
      const context = yield* Effect.context();
      const fake = yield* makeFakeShell();

      const host = {
        dataRoot: "/srv/example",
        home: "/home/example",
        ssh: "example.invalid",
        tailnetIPv4: "203.0.113.10",
      };

      const store = storeUnit({
        binary: "/opt/example/weed",
        config: "/opt/example/store.json",
        data: "/srv/example/seaweedfs",
        home: host.home,
        memoryMax: fleetMemoryLimits.seaweedfs,
        restartOn: ["identity.invalid", "binary.invalid"],
      });

      const node = nodeUnit({
        binary: "/opt/example/celld",
        data: "/srv/example/celld",
        environment: "/opt/example/celld.env",
        host,
        memoryMax: "4608M",
        restartOn: ["environment.invalid", "binary.invalid"],
      });

      const nextNode = nodeUnit({
        binary: "/opt/example/celld",
        data: "/srv/example/celld",
        environment: "/opt/example/celld.env",
        host,
        memoryMax: fleetMemoryLimits.celld,
        restartOn: ["environment.invalid", "binary.invalid"],
      });

      const nextSlice = sliceUnit(host.home, fleetMemoryLimits.slice);

      const real = {
        node: yield* reconcileUnit(fake.shell, node, undefined, false),
        slice: yield* reconcileUnit(
          fake.shell,
          sliceUnit(host.home, "8G"),
          undefined,
          false
        ),
        store: yield* reconcileUnit(fake.shell, store, undefined, false),
      };

      const commands: AsyncCommand<{ applied: boolean }, typeof real>[] = [
        0,
        ...seeds,
      ].map((seed) => ({
        check: () => true,
        run: (model, actual) =>
          Effect.runPromiseWith(context)(
            Effect.gen(function* rollout() {
              const nextStore = { ...store, prepared: [String(seed)] };

              expect(
                needsUpdate(
                  nextSlice,
                  actual.slice,
                  yield* readUnit(fake.shell, nextSlice)
                )
              ).toBe(!model.applied);
              expect(
                needsUpdate(
                  nextNode,
                  actual.node,
                  yield* readUnit(fake.shell, nextNode)
                )
              ).toBe(!model.applied);
              expect(
                needsUpdate(
                  nextStore,
                  actual.store,
                  yield* readUnit(fake.shell, nextStore)
                )
              ).toBe(false);

              const before = (yield* fake.calls()).length;

              yield* stageOwnedUnit(fake.shell, nextNode, {
                attr: actual.node,
              });
              actual.slice = yield* reconcileUnit(
                fake.shell,
                nextSlice,
                actual.slice,
                false
              );
              actual.store = yield* reconcileUnit(
                fake.shell,
                nextStore,
                actual.store,
                false
              );
              actual.node = yield* reconcileUnit(
                fake.shell,
                nextNode,
                actual.node,
                false
              );

              const lifecycle = (yield* fake.calls())
                .slice(before)
                .filter(
                  (call) =>
                    call.operation === "exec" &&
                    ["start", "restart", "stop"].includes(call.argv[2] ?? "")
                )
                .map((call) => call.argv.slice(2));

              expect(lifecycle).toEqual(
                model.applied ? [] : [["restart", nextNode.name]]
              );
              expect(
                actual.node.active && actual.store.active && actual.slice.active
              ).toBe(true);
              model.applied = true;
            })
          ),
        toString: () => `memory rollout ${seed}`,
      }));

      yield* Effect.promise(() =>
        fc.asyncModelRun(() => ({ model: { applied: false }, real }), commands)
      );
    })
);
