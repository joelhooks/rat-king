import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Vitest";
import { Context, Effect, Layer } from "effect";
import { expect } from "vitest";

import { sidecarUnit } from "../src/agent-runtime-files.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { digest } from "../src/files.ts";
import { HostShell } from "../src/host-shell.ts";
import {
  SystemdUnit,
  RemoteFile,
  HostDirectory,
  ReleaseBinary,
  providers,
} from "../src/providers.ts";
import { ReleaseSource } from "../src/release.ts";
import { reconcileUnit, deleteUnit } from "../src/systemd.ts";
import { UnitStartup } from "../src/unit-startup.ts";
import { checkedStack } from "./checked-stack.ts";
import { service } from "./fixtures.ts";

class Fake extends Context.Service<
  Fake,
  Effect.Success<ReturnType<typeof makeFakeShell>> & {
    readonly startupCalls: string[];
  }
>()("Test/FakeShell") {}

const bytes = new TextEncoder().encode("invented binary");

const fake = Layer.effectContext(
  Effect.gen(function* makeTestShell() {
    const shell = yield* makeFakeShell();
    const startupCalls: string[] = [];

    return Context.make(Fake, { ...shell, startupCalls }).pipe(
      Context.add(HostShell, shell.shell),
      Context.add(UnitStartup, {
        afterStart: () =>
          Effect.sync(() => {
            startupCalls.push("after");
          }),
        beforeStart: () =>
          Effect.sync(() => {
            startupCalls.push("before");
          }),
      }),
      Context.add(ReleaseSource, { get: () => Effect.succeed(bytes) })
    );
  })
);

const { test } = Test.make({
  adopt: true,
  providers: providers().pipe(Layer.provideMerge(fake)),
  stage: "provider-tests",
});

test.provider(
  "Alchemy engine creates, updates, adopts, plans noop and deletes user units",
  (scratch) =>
    Effect.gen(function* provider() {
      const stack = checkedStack(scratch);

      const host = yield* Fake;
      const props = service();
      yield* stack.destroy().pipe(Effect.orDie);

      const deployed = yield* stack
        .deploy(SystemdUnit("unit", props))
        .pipe(Effect.orDie);

      expect(deployed.active).toBe(true);
      const trace = yield* Fake;
      expect(trace.startupCalls).toEqual(["before", "after"]);
      trace.startupCalls.length = 0;
      yield* host.clear();
      yield* stack.deploy(SystemdUnit("unit", props)).pipe(Effect.orDie);
      expect(
        (yield* host.calls()).filter((call) => call.operation === "write")
      ).toEqual([]);
      const next = service(undefined, undefined, "60M");

      const updated = yield* stack
        .deploy(SystemdUnit("unit", next))
        .pipe(Effect.orDie);

      expect(updated.sha256).not.toBe(deployed.sha256);
      expect(trace.startupCalls).toEqual(["before", "after"]);
      yield* stack.destroy().pipe(Effect.orDie);
      const seed = yield* reconcileUnit(host.shell, next, undefined, false);

      const adopt = Effect.gen(function* takeOver() {
        yield* host.clear();
        yield* stack.deploy(SystemdUnit("unit", next)).pipe(Effect.orDie);
        expect(
          (yield* host.calls()).filter(
            (call) =>
              call.operation === "write" ||
              call.argv[2] === "restart" ||
              call.argv[2] === "start"
          )
        ).toEqual([]);

        const plan = yield* stack
          .plan(SystemdUnit("unit", next))
          .pipe(Effect.orDie);

        expect(
          Object.values(plan.resources).map((resource) => resource.action)
        ).toEqual(["noop"]);
        yield* stack.destroy().pipe(Effect.orDie);
        expect(yield* host.shell.stat(seed.path)).toBeUndefined();
      });

      yield* adopt.pipe(
        Effect.ensuring(deleteUnit(host.shell, seed).pipe(Effect.orDie))
      );
    })
);

test.provider(
  "sidecar delete disables, unlinks wants and unloads the unit",
  (scratch) =>
    Effect.gen(function* sidecarDelete() {
      const stack = checkedStack(scratch);
      const host = yield* Fake;
      const props = sidecarUnit("/home/example", "invented-runtime");
      const link = `${props.home}/.config/systemd/user/default.target.wants/${props.name}`;

      yield* stack.destroy().pipe(Effect.orDie);

      const output = yield* stack
        .deploy(SystemdUnit("sidecar", props))
        .pipe(Effect.orDie);

      yield* host.symlink(link, output.path);
      yield* host.clear();
      yield* stack.destroy().pipe(Effect.orDie);

      expect(yield* host.shell.stat(output.path)).toBeUndefined();
      expect(yield* host.symlinkTarget(link)).toBeUndefined();

      const calls = yield* host.calls();

      expect(
        calls.some(
          (call) => call.argv[2] === "disable" && call.argv[3] === props.name
        )
      ).toBe(true);
      expect(calls.some((call) => call.argv[2] === "daemon-reload")).toBe(true);

      const manager = yield* host.shell.exec([
        "systemctl",
        "--user",
        "show",
        props.name,
      ]);

      expect(manager.stdout).toContain("LoadState=not-found");
    })
);

test.provider(
  "Alchemy engine replaces files and deletes a binary before its directory",
  (scratch) =>
    Effect.gen(function* provider() {
      const stack = checkedStack(scratch);

      const host = yield* Fake;

      const declare = (content: string) =>
        Effect.gen(function* program() {
          const directory = yield* HostDirectory("directory", {
            mode: 0o700,
            path: "/srv/example/install",
          });

          const config = yield* RemoteFile("config", {
            content,
            mode: 0o600,
            path: Output.interpolate`${directory.path}/config`,
          });

          const binary = yield* ReleaseBinary("binary", {
            asset: { format: "raw" },
            path: Output.interpolate`${directory.path}/binary`,
            sha256: digest(bytes),
            size: bytes.length,
            url: "https://github.com/example/project/releases/download/v1/tool",
          });

          return { binary, config };
        });

      const first = yield* stack.deploy(declare("first")).pipe(Effect.orDie);
      const second = yield* stack.deploy(declare("second")).pipe(Effect.orDie);
      expect(second.config.sha256).not.toBe(first.config.sha256);
      expect(second.binary.sha256).toBe(first.binary.sha256);
      yield* stack.destroy().pipe(Effect.orDie);
      expect(yield* host.shell.stat("/srv/example/install")).toBeUndefined();
    })
);
