import * as Test from "alchemy/Test/Vitest";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { Deployment, DeploymentProvider } from "../src/deployment.ts";
import type { DeploymentProps } from "../src/deployment.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { HostShell } from "../src/host-shell.ts";
import { checkedStack } from "./checked-stack.ts";

class Commands extends Context.Service<
  Commands,
  Ref.Ref<readonly (readonly string[])[]>
>()("Test/DeploymentCommands") {}

const directory = "/home/example/.config/rat-king/mailbox-deployment";

const observedIdentity = Schema.Struct({
  commit: Schema.String,
  version: Schema.String,
});

const runtime = Layer.effectContext(
  Effect.gen(function* deploymentTestRuntime() {
    const fake = yield* makeFakeShell();
    const commands = yield* Ref.make<readonly (readonly string[])[]>([]);

    const shell = {
      ...fake.shell,
      exec: (argv: readonly string[]) =>
        Ref.update(commands, (calls) => [...calls, argv]).pipe(
          Effect.andThen(
            argv[0] === "python3"
              ? fake.shell.exec(argv)
              : Effect.succeed({ code: 0, stdout: "{}" })
          )
        ),
    };

    const http = HttpClient.make((request) =>
      Effect.gen(function* versionReadback() {
        const bytes = yield* shell.read(`${directory}/worker.mjs`);

        const identity = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(observedIdentity)
        )(new TextDecoder().decode(bytes));

        return HttpClientResponse.fromWeb(request, Response.json(identity));
      }).pipe(Effect.orDie)
    );

    return Context.make(HostShell, shell).pipe(
      Context.add(Commands, commands),
      Context.add(HttpClient.HttpClient, http)
    );
  })
);

const { test } = Test.make({
  providers: DeploymentProvider().pipe(Layer.provideMerge(runtime)),
  stage: "deployment-tests",
});

const props = (version: string): DeploymentProps => ({
  binary: "/srv/example/celld",
  bundle: JSON.stringify({ commit: "1234567", version }),
  commit: "1234567",
  configuration: JSON.stringify({
    compatibility_date: "2026-10-04",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: { bindings: [] },
    main: "worker.mjs",
    migrations: [],
    name: "example",
    no_bundle: true,
    vars: {},
  }),
  directory,
  environmentFile: "/srv/example/celld.env",
  internalUrl: "http://127.0.0.1:18788",
  version,
  workerUrl: "http://worker.example:18787",
});

test.provider(
  "deployment ships before deploy and reload, verifies identity, updates and plans noop",
  (scratch) =>
    Effect.gen(function* deploymentLifecycle() {
      const stack = checkedStack(scratch);
      const commands = yield* Commands;
      yield* stack.destroy();
      const first = yield* stack.deploy(Deployment("mailbox", props("v1")));
      const calls = yield* Ref.get(commands);
      expect(calls.map((argv) => argv[0])).toEqual(["sh", "curl"]);
      expect(calls[0]?.[2]).toContain(" deploy ");
      expect(calls[1]).toContain("http://127.0.0.1:18788/reload");
      const plan = yield* stack.plan(Deployment("mailbox", props("v1")));
      expect(
        Object.values(plan.resources).map((resource) => resource.action)
      ).toEqual(["noop"]);
      const updated = yield* stack.deploy(Deployment("mailbox", props("v2")));
      expect(updated.sha256).not.toBe(first.sha256);
      expect(updated.version).toBe("v2");
      yield* Ref.set(commands, []);
      yield* stack.destroy();
      expect((yield* Ref.get(commands)).map((argv) => argv[0])).toEqual([
        "python3",
      ]);
      const shell = yield* HostShell;
      expect(yield* shell.stat(directory)).toBeUndefined();
    })
);
