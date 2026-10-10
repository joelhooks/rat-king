import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  { command: Schema.String, reason: Schema.String }
) {}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
}

const limit = 1_048_576;

export const runCommand = Effect.fn("RatKing.runCommand")(function* runCommand(
  argv: readonly [string, ...string[]],
  input?: Uint8Array
) {
  const [command, ...args] = argv;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const failed = (reason: string) => () =>
    new CommandFailed({ command, reason });

  return yield* Effect.gen(function* run() {
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        stderr: "ignore",
        stdin: input === undefined ? "ignore" : Stream.succeed(input),
      })
    );

    const [code, chunks] = yield* Effect.all(
      [handle.exitCode, Stream.runCollect(Stream.take(handle.stdout, 4096))],
      { concurrency: "unbounded" }
    );

    const bytes = chunks.reduce((total, chunk) => total + chunk.length, 0);

    if (bytes > limit) {
      return yield* failed("Command output too large")();
    }

    const output = new Uint8Array(bytes);
    let offset = 0;

    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }

    return {
      code,
      stdout: new TextDecoder().decode(output),
    } satisfies CommandResult;
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      Schema.is(CommandFailed)(error)
        ? error
        : failed("Command could not run")()
    ),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(failed("Command timed out")()),
    })
  );
});
