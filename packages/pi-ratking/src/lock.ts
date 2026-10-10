import {
  Clock,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";

export class LockBusy extends Schema.TaggedError<LockBusy>()("LockBusy", {
  reason: Schema.String,
}) {}

const staleAfterMillis = 30_000;

export const withLock = <A, E, R>(
  directory: string,
  name: string,
  effect: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* lock() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = path.join(directory, `${name}.lock`);

    const busy = () => new LockBusy({ reason: `${name} lock is busy` });

    yield* fs
      .makeDirectory(directory, { mode: 0o700, recursive: true })
      .pipe(Effect.mapError(busy));

    const clearStale = Effect.gen(function* clearStale() {
      const info = yield* fs.stat(lockPath);
      const now = yield* Clock.currentTimeMillis;

      const modified = Option.match(info.mtime, {
        onNone: () => now,
        onSome: (date) => date.getTime(),
      });

      if (now - modified > staleAfterMillis) {
        yield* fs.remove(lockPath, { recursive: true });
      }
    }).pipe(Effect.ignore);

    const take = fs.makeDirectory(lockPath, { mode: 0o700 }).pipe(
      Effect.tapError(() => clearStale),
      Effect.retry(
        Schedule.spaced("50 millis").pipe(
          Schedule.upTo({ duration: "10 seconds" })
        )
      ),
      Effect.mapError(busy)
    );

    return yield* Effect.acquireUseRelease(
      take,
      () => effect,
      () => fs.remove(lockPath, { recursive: true }).pipe(Effect.ignore)
    );
  });
