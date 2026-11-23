import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { FleetError } from "./stage-config.ts";

export const decodeUtf8 = (bytes: Uint8Array) =>
  Effect.try({
    catch: () => new FleetError({ reason: "Read-only evidence is not UTF-8" }),
    try: () =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  });

export const boundedOutput = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maximum: number
) =>
  Effect.gen(function* collectBounded() {
    const bytes = new Uint8Array(maximum);
    let length = 0;
    yield* Stream.runForEach(stream, (chunk) => {
      if (length + chunk.length > maximum) {
        return Effect.fail(
          new FleetError({
            reason: "Read-only evidence exceeded its byte limit",
          })
        );
      }

      bytes.set(chunk, length);
      length += chunk.length;

      return Effect.void;
    });

    return yield* decodeUtf8(bytes.subarray(0, length));
  });

export const readCommand = Effect.fn("Ship.readCommand")(
  function* readCommand(
    command: string,
    args: readonly string[],
    cwd: string,
    maximum: number,
    env: Readonly<Record<string, string>>
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const process = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        env,
        extendEnv: false,
        forceKillAfter: "1 second",
        stderr: "ignore",
        stdin: "ignore",
      })
    );

    const [code, output] = yield* Effect.all(
      [process.exitCode, boundedOutput(process.stdout, maximum)],
      { concurrency: "unbounded" }
    );

    if (Number(code) !== 0) {
      return yield* new FleetError({
        reason: "Read-only command could not furnish evidence",
      });
    }

    return output;
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeout("30 seconds"),
      Effect.mapError(
        () =>
          new FleetError({
            reason: "Read-only command unavailable or output refused",
          })
      )
    )
);
