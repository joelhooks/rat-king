import * as Test from "@alchemy.run/test/Vitest";
import * as Output from "alchemy/Output";
import { Context, Effect, Layer } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { HostShell } from "../src/host-shell.ts";
import { NodeProvider, NodeResource } from "../src/node-provider.ts";
import type { NodeProps } from "../src/node-provider.ts";
import { SystemdUnit, SystemdUnitProvider } from "../src/providers.ts";
import { unitPath } from "../src/systemd.ts";
import { checkedStack } from "./checked-stack.ts";
import { service } from "./fixtures.ts";

class Fake extends Context.Service<
  Fake,
  Effect.Success<ReturnType<typeof makeFakeShell>>
>()("Test/NodeStables") {}

const fake = Layer.effectContext(
  Effect.gen(function* fixture() {
    const shell = yield* makeFakeShell();

    return Context.make(Fake, shell).pipe(Context.add(HostShell, shell.shell));
  })
);

const { test } = Test.make({
  providers: Layer.merge(NodeProvider(), SystemdUnitProvider()).pipe(
    Layer.provideMerge(fake)
  ),
  stage: "node-stables",
});

const home = "/home/example";

const name = "rat-king-celld.service";

const node = (restartOn: readonly string[], exec = "/bin/sleep infinity") => {
  const base = service(home, name);

  const withExec = (section: NodeProps["sections"][number]) => ({
    ...section,
    lines: section.lines.map(([key, value]): readonly [string, string] => [
      key,
      key === "ExecStart" ? exec : value,
    ]),
  });

  const [first, ...rest] = base.sections;

  const props: NodeProps = {
    ...base,
    internalUrl: "http://127.0.0.1:18788",
    publicUrl: "http://fixture.invalid:18787",
    restartOn,
    sections: [withExec(first), ...rest.map(withExec)],
    version: "v0.6.1",
  };

  return props;
};

const graph = (props: NodeProps) =>
  Effect.gen(function* declare() {
    const celld = yield* NodeResource("node", props);

    const dependent = yield* SystemdUnit(
      "dependent",
      celld.sha256.pipe(
        Output.map((sha256) => ({
          ...service(home, "rat-king-dependent.service"),
          restartOn: [sha256],
        }))
      )
    );

    return dependent.sha256;
  });

test.provider("a binary-only change leaves the dependent noop", (scratch) =>
  Effect.gen(function* binaryOnly() {
    const stack = checkedStack(scratch);
    yield* stack.deploy(graph(node(["binary-a"])));
    const plan = yield* stack.plan(graph(node(["binary-b"])));

    expect(plan.resources.node?.action).toBe("update");
    expect(plan.resources.dependent?.action).toBe("noop");
  })
);

test.provider("a unit-text change still propagates update", (scratch) =>
  Effect.gen(function* textChange() {
    const stack = checkedStack(scratch);
    yield* stack.deploy(graph(node(["binary-a"])));

    const plan = yield* stack.plan(
      graph(node(["binary-a"], "/bin/sleep 1000000"))
    );

    expect(plan.resources.node?.action).toBe("update");
    expect(plan.resources.dependent?.action).toBe("update");
  })
);

test.provider("drifted live bytes withhold the stable", (scratch) =>
  Effect.gen(function* drift() {
    const stack = checkedStack(scratch);
    const shell = yield* Fake;
    yield* stack.deploy(graph(node(["binary-a"])));

    yield* shell.shell.write({
      bytes: new TextEncoder().encode("[Unit]\nDescription=drifted\n"),
      mode: 0o644,
      path: unitPath({ home, name }),
    });

    const plan = yield* stack.plan(graph(node(["binary-b"])));

    expect(plan.resources.node?.action).toBe("update");
    expect(plan.resources.dependent?.action).toBe("update");
  })
);
