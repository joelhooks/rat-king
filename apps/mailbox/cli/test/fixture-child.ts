import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const fixtureChild = Effect.fn("Test.fixtureChild")(
  function* fixtureChild(
    args: readonly string[],
    home: string,
    env: Readonly<Record<string, string>> = {},
    stdin?: string
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, args, {
        env: { HOME: home, PATH: home, ...env },
        extendEnv: false,
        stdin: Stream.succeed(new TextEncoder().encode(stdin ?? "")),
      })
    );

    return yield* Effect.all(
      {
        code: child.exitCode.pipe(Effect.map(Number)),
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      },
      { concurrency: "unbounded" }
    );
  },
  Effect.scoped,
  Effect.timeout("20 seconds")
);
