import { Effect, FileSystem, Path, Schema, Stream } from "effect";

export const RESTART_GATE_POLL = "5 seconds";

const decodeGate = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.String)
);

const OWNER_ONLY = 0o600;

const MODE_SPAN = 0o1000;

export const restartGateOpen = (path: string, session: string) =>
  Effect.gen(function* inspectGate() {
    const fs = yield* FileSystem.FileSystem;
    const linked = yield* fs.readLink(path).pipe(Effect.isSuccess);

    if (linked) {
      return false;
    }

    const info = yield* fs.stat(path);

    return (
      info.type === "File" &&
      info.mode % MODE_SPAN === OWNER_ONLY &&
      decodeGate(yield* fs.readFileString(path)) === session
    );
  }).pipe(Effect.orElseSucceed(() => false));

export const awaitRestartGate = (
  path: string,
  session: string
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* awaitGate() {
    const fs = yield* FileSystem.FileSystem;
    const location = yield* Path.Path;

    const changed = fs.watch(location.dirname(path)).pipe(
      Stream.take(1),
      Stream.runDrain,
      Effect.catchCause((_cause) => Effect.never)
    );

    const settle: Effect.Effect<void, never, FileSystem.FileSystem> =
      restartGateOpen(path, session).pipe(
        Effect.flatMap((open) =>
          open
            ? Effect.void
            : Effect.raceFirst(changed, Effect.sleep(RESTART_GATE_POLL)).pipe(
                Effect.flatMap(() => Effect.suspend(() => settle))
              )
        )
      );

    return yield* settle;
  });
