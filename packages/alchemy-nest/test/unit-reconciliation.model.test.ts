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
import {
  needsUpdate,
  readUnit,
  reconcileUnit,
  renderUnit,
} from "../src/systemd.ts";
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

const ControlCycle = Schema.Struct({
  cap: Schema.Literals(["8G", "14G"]),
  correctSection: Schema.Boolean,
  key: Schema.Literals([
    "MemoryMax",
    "MemorySwapMax",
    "CPUQuota",
    "TasksMax",
    "MemoryHigh",
    "ExecStart",
  ]),
  kind: Schema.Literals([
    "persistent",
    "runtime",
    "ordinary",
    "none",
    "unreadable",
  ]),
  matching: Schema.Boolean,
});

it.effect.prop(
  "declared resource control drop-ins block plan and apply without mutation, while reviewed cleanup and reload leave matching services running",
  [Schema.Boolean, Schema.Array(ControlCycle).check(Schema.isMaxLength(6))],
  ([slice, cycles]) =>
    Effect.gen(function* controlCustodyModel() {
      const context = yield* Effect.context();
      const fake = yield* makeFakeShell();
      const section = slice ? "Slice" : "Service";
      const name = `fixture.invalid.${slice ? "slice" : "service"}`;
      const home = "/home/example";

      const declaration = (cap: string): UnitProps => ({
        home,
        name,
        scope: "user",
        sections: [
          { lines: [["MemoryMax", cap]], name: section },
          {
            lines: [
              ["MemorySwapMax", "0"],
              ["CPUQuota", "200%"],
              ["TasksMax", "2048"],
              ...(slice
                ? []
                : [
                    ["ExecStart", "/opt/fixture"] satisfies readonly [
                      string,
                      string,
                    ],
                  ]),
            ],
            name: section,
          },
        ],
      });

      const initialCap = slice ? "14G" : "8G";

      const real = {
        output: yield* reconcileUnit(
          fake.shell,
          declaration(initialCap),
          undefined,
          false
        ),
      };

      let reportedPath = "";
      let control: Uint8Array | undefined;

      const shell = {
        ...fake.shell,
        exec: (argv: readonly string[]) =>
          fake.shell.exec(argv).pipe(
            Effect.map((result) =>
              argv[2] === "show" && !argv.includes("--value")
                ? {
                    ...result,
                    stdout: result.stdout.replace(
                      "DropInPaths=\n",
                      `DropInPaths=${reportedPath}\n`
                    ),
                  }
                : result
            )
          ),
        read: (path: string) =>
          path === reportedPath
            ? Effect.succeed(control)
            : fake.shell.read(path),
      };

      const transitions: (typeof ControlCycle.Type)[] = [
        {
          cap: initialCap,
          correctSection: true,
          key: "MemoryMax",
          kind: "persistent",
          matching: true,
        },
        {
          cap: initialCap,
          correctSection: true,
          key: "MemoryMax",
          kind: "runtime",
          matching: false,
        },
        {
          cap: initialCap,
          correctSection: true,
          key: "MemoryMax",
          kind: "none",
          matching: true,
        },
        ...cycles,
      ];

      const commands: AsyncCommand<{ cap: string }, typeof real>[] =
        transitions.map((cycle) => ({
          check: () => true,
          run: (model, actual) =>
            Effect.runPromiseWith(context)(
              Effect.gen(function* controlStep() {
                const prefix = {
                  none: "",
                  ordinary: `${home}/.config/systemd/user`,
                  persistent: `${home}/.config/systemd/user.control`,
                  runtime: "/run/user/1234/systemd/user.control",
                  unreadable: `${home}/.config/systemd/user.control`,
                }[cycle.kind];

                reportedPath =
                  prefix === ""
                    ? ""
                    : `${prefix}/${name}.d/50-${cycle.key}.conf`;

                const next = declaration(cycle.cap);

                const value = cycle.matching
                  ? (next.sections
                      .flatMap((item) => item.lines)
                      .find(([key]) => key === cycle.key)?.[1] ?? "0")
                  : "1";

                const text = `# Created via systemctl set-property\n[${cycle.correctSection ? section : "Unit"}]\n ${cycle.key} = ${value}\nEnvironment=KEEP=1\n# MemoryMax=1\n`;

                control =
                  cycle.kind === "unreadable"
                    ? undefined
                    : new TextEncoder().encode(text);

                if (cycle.kind === "none") {
                  const beforeReload = (yield* fake.calls()).length;

                  yield* shell.exec(["systemctl", "--user", "daemon-reload"]);

                  expect(
                    (yield* fake.calls())
                      .slice(beforeReload)
                      .filter((call) => call.operation === "exec")
                      .map((call) => call.argv[2])
                  ).toEqual(["daemon-reload"]);
                }

                const blocked =
                  cycle.kind === "unreadable" ||
                  ((cycle.kind === "persistent" || cycle.kind === "runtime") &&
                    cycle.correctSection &&
                    [
                      "MemoryMax",
                      "MemorySwapMax",
                      "CPUQuota",
                      "TasksMax",
                    ].includes(cycle.key));

                const before = (yield* fake.calls()).length;

                const planned = yield* readUnit(shell, next).pipe(
                  Effect.result
                );

                const applied = yield* reconcileUnit(
                  shell,
                  next,
                  actual.output,
                  false
                ).pipe(Effect.result);

                const calls = (yield* fake.calls()).slice(before);

                expect(Result.isFailure(planned)).toBe(blocked);
                expect(Result.isFailure(applied)).toBe(blocked);

                if (Result.isFailure(applied)) {
                  expect(applied.failure.reason).toContain(reportedPath);
                  expect(applied.failure.reason).toContain("re-run the plan");

                  if (cycle.kind !== "unreadable") {
                    expect(applied.failure.reason).toContain(cycle.key);
                    expect(applied.failure.reason).toContain(
                      `mv -n -- '${reportedPath}' '${reportedPath}.disabled'`
                    );
                    expect(applied.failure.reason).toContain(
                      "systemctl --user daemon-reload"
                    );
                    expect(new TextDecoder().decode(control)).toBe(text);
                  }

                  expect(
                    calls.some((call) =>
                      ["write", "remove", "mkdir", "rmdir"].includes(
                        call.operation
                      )
                    )
                  ).toBe(false);
                  expect(
                    calls
                      .filter((call) => call.operation === "exec")
                      .every((call) => call.argv[2] === "show")
                  ).toBe(true);
                } else {
                  if (Result.isSuccess(planned)) {
                    expect(
                      needsUpdate(next, actual.output, planned.success)
                    ).toBe(cycle.cap !== model.cap);
                  }

                  expect(
                    calls
                      .filter(
                        (call) =>
                          call.operation === "exec" &&
                          ["start", "restart", "stop"].includes(
                            call.argv[2] ?? ""
                          )
                      )
                      .map((call) => call.argv.slice(2))
                  ).toEqual(
                    !slice && cycle.cap !== model.cap ? [["restart", name]] : []
                  );
                  actual.output = applied.success;
                  model.cap = cycle.cap;
                }

                expect(
                  new TextDecoder().decode(
                    yield* fake.shell.read(actual.output.path)
                  )
                ).toBe(renderUnit(declaration(model.cap)));
                expect(actual.output.active).toBe(true);
              })
            ),
          toString: () => JSON.stringify(cycle),
        }));

      yield* Effect.promise(() =>
        fc.asyncModelRun(() => ({ model: { cap: initialCap }, real }), commands)
      );
    })
);
