import { it } from "@effect/vitest";
import { Arbitrary, Effect, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { assess, collectHealth } from "../../../stacks/nest/health.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { HostShell } from "../src/host-shell.ts";
import { stopUnlessServing } from "../src/listener-cleanup.ts";
import { declaredListeners } from "../src/listener-contract.ts";
import { listenerProbe } from "../src/listener-probe.ts";
import { assessListeners } from "../src/listeners.ts";

const address = "203.0.113.10";

const units = [
  "rat-king-seaweedfs.service",
  "rat-king-celld.service",
  "rat-king-claude-sidecar.service",
];

const cgroup = (unit: string) => `/user.slice/rat.slice/rat-king.slice/${unit}`;

const unitCgroups = new Map(units.map((unit) => [unit, cgroup(unit)]));

const clean = declaredListeners(address, true, false)
  .map(
    ({ address: bind, port, unit }) =>
      `LISTEN 0 4096 ${bind}:${port} 0.0.0.0:* users:(("celld",pid=7,fd=3)) cgroup:${cgroup(unit)}`
  )
  .join("\n");

const foreign = (process: string, pid: number, bind = "127.0.0.1") =>
  `LISTEN 0 128 ${bind}:18787 0.0.0.0:* users:(("${process}",pid=${pid},fd=9)) cgroup:/user.slice/session-3.scope`;

const scripted = Effect.fn("scripted")(function* scripted(
  output: string,
  calls: (readonly string[])[] = []
) {
  const fake = yield* makeFakeShell();

  return HostShell.of({
    ...fake.shell,
    exec: (argv) =>
      Effect.sync(() => {
        calls.push(argv);

        if (argv[0] === "ss") {
          return { code: 0, stdout: output };
        }

        if (argv.includes("--property=ControlGroup")) {
          const unit = argv.find((arg) => arg.endsWith(".service")) ?? "";

          return { code: 0, stdout: cgroup(unit) };
        }

        return { code: 0, stdout: "" };
      }),
  });
});

const naming = {
  pid: Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }))
  ),
  process: Arbitrary.schema(
    Schema.Literals(["sshd-session", "ssh", "socat", "python3"])
  ),
};

it("a clean layout is Ready", () => {
  expect(assessListeners(clean, address, true, false, unitCgroups)._tag).toBe(
    "Ready"
  );
});

it.effect.prop(
  "a foreign listener on a stack port fails the probe and names its process, address-agnostic",
  { ...naming, v6: Arbitrary.schema(Schema.Boolean) },
  ({ pid, process, v6 }) =>
    Effect.gen(function* foreignPort() {
      const calls: (readonly string[])[] = [];

      const output = `${clean}\n${foreign(process, pid, v6 ? "[::1]" : "127.0.0.1")}`;

      const failure = yield* listenerProbe(
        yield* scripted(output, calls),
        address,
        true,
        false
      ).pipe(Effect.result);

      expect(Result.isFailure(failure)).toBe(true);
      expect(String(Result.isFailure(failure) && failure.failure)).toContain(
        `port 18787 held by ${process} (pid ${pid}), not a Rat King unit`
      );
      expect(calls.some((argv) => argv.includes("stop"))).toBe(false);
    })
);

it.effect.prop(
  "units are stopped after a failed probe only when celld is not serving",
  { serving: Arbitrary.schema(Schema.Boolean) },
  ({ serving }) =>
    Effect.gen(function* cleanup() {
      const calls: (readonly string[])[] = [];

      yield* stopUnlessServing(
        yield* scripted("", calls),
        Effect.succeed(serving),
        ["rat-king-celld.service", "rat-king-seaweedfs.service"]
      );

      const stopped = calls.flatMap((argv) =>
        argv.includes("stop") ? [argv.at(-1) ?? ""] : []
      );

      expect(stopped.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
        serving ? [] : ["rat-king-celld.service", "rat-king-seaweedfs.service"]
      );
    })
);

it.effect.prop(
  "the digest names a foreign listener and does not count it as ours",
  naming,
  ({ pid, process }) =>
    Effect.gen(function* digest() {
      const output = `${clean}\n${foreign(process, pid)}`;
      const inner = yield* scripted(output);

      const facts = yield* collectHealth(
        {
          exec: (argv) => {
            const command = argv.slice(4);

            return command[0] === "ss" ||
              command.includes("--property=ControlGroup")
              ? inner.exec(command)
              : Effect.succeed({ code: 1, stdout: "" });
          },
        },
        {
          backupRoot: "/srv/backups",
          bucket: "rat-king-cells",
          dataRoot: "/data",
          healthUrl: "http://192.0.2.10:18787/.well-known/celld/health",
          home: "/home/example",
          publicIPv4: address,
          sidecar: false,
        }
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("ok"))
            )
          )
        )
      );

      expect(facts.listeners?.count).toBe(facts.listeners?.expected);
      expect(assess(facts).reasons).toContain(
        `port 18787 held by ${process} (pid ${pid}), not a Rat King unit`
      );
    })
);
