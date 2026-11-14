import * as Test from "@alchemy.run/test/Vitest";
import { Context, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import {
  Deployment,
  DeploymentProvider,
  bindingConfigurationScriptFor,
} from "../src/deployment.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { HostShell } from "../src/host-shell.ts";
import { checkedStack } from "./checked-stack.ts";

class Commands extends Context.Service<Commands, (readonly string[])[]>()(
  "Test/DeploymentCommands"
) {}

const identity = { commit: "example-commit", version: "example-version" };

const props = {
  ...identity,
  binary: "/home/example/.local/share/rat-king/bin/celld",
  bindingsFile: "/home/example/.config/rat-king/bindings.json",
  bundle: "export default {};",
  configuration: JSON.stringify({
    compatibility_date: "2026-10-04",
    compatibility_flags: [],
    durable_objects: { bindings: [] },
    main: "worker.mjs",
    migrations: [],
    name: "example-worker",
    no_bundle: true,
    vars: {},
  }),
  directory: "/home/example/.config/rat-king/mailbox-deployment",
  environmentFile: "/home/example/.config/rat-king/celld.env",
  internalUrl: "http://127.0.0.1:18788",
  workerUrl: "http://203.0.113.10:18787",
};

const runtime = Layer.effectContext(
  Effect.gen(function* fakeRuntime() {
    const fake = yield* makeFakeShell();
    const commands: (readonly string[])[] = [];

    return Context.make(Commands, commands).pipe(
      Context.add(HostShell, {
        ...fake.shell,
        exec: (argv) =>
          Effect.sync(() => {
            commands.push(argv);

            return { code: 0, stdout: "" };
          }),
      }),
      Context.add(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json(identity))
          )
        )
      )
    );
  })
);

const { test } = Test.make({
  providers: DeploymentProvider().pipe(Layer.provideMerge(runtime)),
  stage: "deployment-secret-tests",
});

test.provider(
  "provider forwards custom deployment secret names to private binding generation",
  (scratch) =>
    Effect.gen(function* wiring() {
      const secretNames = ["GATE_CREDENTIAL"];
      yield* checkedStack(scratch).deploy(
        Deployment("worker", { ...props, secretNames })
      );
      const commands = yield* Commands;
      expect(commands.find((argv) => argv[0] === "python3")?.[2]).toBe(
        bindingConfigurationScriptFor(secretNames)
      );
    })
);

test.provider(
  "default deployment fingerprint keeps main 920884e bytes",
  (scratch) =>
    Effect.gen(function* compatibility() {
      const output = yield* checkedStack(scratch).deploy(
        Deployment("worker", props)
      );

      expect(output.sha256).toMatchSnapshot();

      const equivalent = yield* checkedStack(scratch).plan(
        Deployment("worker", {
          ...props,
          secretNames: [
            "AGENT_IDENTITIES_CREDENTIAL",
            "MODEL_GATEWAY_CREDENTIAL",
            "CLAUDE_SIDECAR_CREDENTIAL",
          ],
        })
      );

      expect(
        Object.values(equivalent.resources).map((resource) => resource.action)
      ).toEqual(["noop"]);

      const changed = yield* checkedStack(scratch).plan(
        Deployment("worker", { ...props, secretNames: ["GATE_CREDENTIAL"] })
      );

      expect(
        Object.values(changed.resources).map((resource) => resource.action)
      ).toEqual(["update"]);
    })
);
