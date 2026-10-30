import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Console, Effect, Schema, Stream } from "effect";
import { Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";

import {
  command as mailboxCommand,
  runMailbox,
} from "../../mailbox/cli/main.ts";
import { command, runRatking } from "../src/main.ts";
import { captured } from "./fixture.ts";

const clientCommands = [
  ["", true],
  ["send", true],
  ["ask", true],
  ["reply", true],
  ["inbox", false],
  ["read", true],
  ["thread", true],
  ["pending", false],
  ["whoami", false],
  ["doctor", false],
  ["health", true],
  ["attention", true],
  ["attention show", false],
  ["attention set", false],
  ["attention busy", true],
  ["attention dnd", true],
  ["attention available", false],
  ["attention allow", false],
  ["attention refuse", false],
  ["attention forward", false],
  ["attention mute", false],
  ["attention test", false],
  ["attention log", false],
  ["filter", true],
  ["filter add", true],
  ["filter remove", true],
  ["filter list", false],
  ["identity", true],
  ["provision", true],
  ["retire", true],
  ["unretire", true],
  ["retired", false],
  ["traffic", true],
  ["snapshot", true],
  ["resolve", true],
  ["role", true],
  ["role list", false],
] as const;

const mailboxCommands = [
  ["", true],
  ["send", true],
  ["list", true],
  ["traffic", true],
  ["open", true],
  ["identity", true],
  ["provision", true],
  ["register", true],
  ["enroll-host", true],
  ["retire", true],
  ["unretire", true],
  ["retired", false],
  ["successor", true],
  ["successor set", true],
  ["role", true],
  ["role set", true],
  ["role delete", true],
  ["role list", false],
  ["lease", true],
  ["lease acquire", true],
  ["lease renew", true],
  ["lease resolve", true],
  ["lease release", true],
  ["deliver", true],
  ["ack", true],
] as const;

const clients = [
  {
    bin: "apps/ratking-cli/bin/ratking.ts",
    commands: clientCommands,
    root: command,
    run: runRatking,
  },
  {
    bin: "apps/mailbox/cli/main.ts",
    commands: mailboxCommands,
    root: mailboxCommand,
    run: runMailbox,
  },
] as const;

const Diagnostic = Schema.Struct({
  failed: Schema.String,
  next: Schema.String,
  why: Schema.String,
});

interface Output {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

const expectUsage = (result: Output, path: string) => {
  expect(result.status, result.stderr).toBe(2);

  const diagnostic = Schema.decodeUnknownSync(
    Schema.fromJsonString(Diagnostic)
  )(result.stderr.trim());

  expect(diagnostic.failed).toBe(path);
  expect(diagnostic.next).toContain(`${path} --help`);
  expect(diagnostic.why.length).toBeGreaterThan(0);
};

const paths = (value: Command.Command.Any, prefix = ""): readonly string[] => [
  prefix,
  ...value.subcommands.flatMap((group) =>
    group.commands.flatMap((child) =>
      paths(child, [prefix, child.name].filter(Boolean).join(" "))
    )
  ),
];

const parserOnly = (
  value: Command.Command.Any
): Command.Command<string, never, unknown> =>
  value.pipe(
    Command.withHandler(() => Effect.void),
    Command.withSubcommands(
      value.subcommands.flatMap((group) => group.commands.map(parserOnly))
    )
  );

const boundary = Effect.fn("UsageTest.boundary")(function* boundary<E>(
  program: Effect.Effect<void, E>
) {
  const output = captured();
  const previous = process.exitCode;
  process.exitCode = undefined;

  try {
    yield* program.pipe(Effect.provideService(Console.Console, output.console));

    return {
      status: process.exitCode ?? 0,
      stderr: output.stderr.join("\n"),
      stdout: output.stdout.join("\n"),
    };
  } finally {
    process.exitCode = previous;
  }
});

for (const client of clients) {
  it(`${client.root.name} table covers the entire command tree`, () => {
    expect(client.commands.map(([path]) => path).toSorted()).toEqual(
      paths(client.root).toSorted()
    );
  });

  for (const [path, required] of client.commands) {
    it.effect(
      `${client.root.name} ${path}: no args, unknown flag, bad value`,
      () =>
        Effect.gen(function* commandUsage() {
          const args = path === "" ? [] : path.split(" ");
          const fullPath = [client.root.name, path].filter(Boolean).join(" ");

          const run = (input: readonly string[]) =>
            boundary(
              client.run(input).pipe(Effect.provide(NodeServices.layer))
            );

          if (required) {
            expectUsage(yield* run(args), fullPath);
          } else {
            const parsed = yield* boundary(
              Command.runWith(parserOnly(client.root), { version: "0.1.0" })(
                args
              ).pipe(Effect.provide(NodeServices.layer))
            );

            expect(parsed.status).toBe(0);
            expect(parsed.stderr).toBe("");
          }

          expectUsage(yield* run([...args, "--nope"]), fullPath);
          expectUsage(
            yield* run([...args, "--log-level", "not-a-level"]),
            fullPath
          );
        })
    );
  }
}

const subprocess = Effect.fn("UsageTest.subprocess")(
  function* subprocess(bin: string, args: readonly string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [bin, ...args], {
        cwd: new URL("../../../", import.meta.url).pathname,
        env: {
          HOME: "/nonexistent/ratking-usage-test",
          NO_COLOR: "1",
          RATKING_CONFIG: "/nonexistent/ratking-usage-test/config.json",
        },
        extendEnv: false,
        stdin: "ignore",
      })
    );

    const output = yield* Effect.all(
      {
        status: child.exitCode,
        stderr: Stream.runCollect(child.stderr),
        stdout: Stream.runCollect(child.stdout),
      },
      { concurrency: "unbounded" }
    );

    return {
      status: Number(output.status),
      stderr: Buffer.concat(output.stderr).toString(),
      stdout: Buffer.concat(output.stdout).toString(),
    };
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer)
);

for (const { bin, root } of clients) {
  for (const args of [
    ["bogus-cmd"],
    ["--nope"],
    ["--log-level", "not-a-level"],
    [],
  ]) {
    it.effect(`${root.name} process usage exit: ${args.join(" ")}`, () =>
      Effect.gen(function* processUsage() {
        expectUsage(yield* subprocess(bin, args), root.name);
      })
    );
  }

  for (const flag of ["--help", "--version"]) {
    it.effect(`${root.name} ${flag} exits 0`, () =>
      Effect.gen(function* builtin() {
        const result = yield* subprocess(bin, [flag]);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
      })
    );
  }
}

for (const [bin, args] of [
  [
    "apps/ratking-cli/bin/ratking.ts",
    [
      "resolve",
      "--names",
      "/nonexistent/names.json",
      "--out",
      "/nonexistent/output.json",
    ],
  ],
  ["apps/mailbox/cli/main.ts", ["list", "--as", "example"]],
] as const) {
  it.effect(`${bin} runtime failure exits 1`, () =>
    Effect.gen(function* runtimeFailure() {
      const result = yield* subprocess(bin, args);

      expect(result.status, result.stderr).toBe(1);
    })
  );
}
