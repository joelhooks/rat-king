import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, DateTime, Deferred, Effect, FileSystem, Queue } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { withLock } from "../src/lock.ts";
import { runCommand } from "../src/process.ts";

const contender = `
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { NodeServices } from ${JSON.stringify(import.meta.resolve("@effect/platform-node"))};
import { withLock } from ${JSON.stringify(new URL("../src/lock.ts", import.meta.url).href)};
const outcome = await Effect.runPromise(withLock(process.argv[1], "provision", Effect.succeed("entered")).pipe(
  Effect.catchTag("LockBusy", () => Effect.succeed("busy")),
  Effect.provide(NodeServices.layer)
));
console.log(outcome);
`;

it.effect(
  "another process cannot enter a provision lock held past the stale threshold",
  () =>
    Effect.gen(function* liveProvisionLock() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const ready = yield* Deferred.make<null>();
      const done = yield* Deferred.make<null>();
      const timestamps = yield* Queue.unbounded<Date | number>();
      const lockPath = `${directory}/provision.lock`;
      const now = yield* TestClock.withLive(Clock.currentTimeMillis);
      const started = now - 35_000;

      yield* TestClock.setTime(started);

      const startDate = DateTime.toDate(DateTime.makeUnsafe(started));

      const hold = fs
        .utimes(lockPath, startDate, startDate)
        .pipe(
          Effect.andThen(Deferred.succeed(ready, null)),
          Effect.andThen(Deferred.await(done))
        );

      const tracked = FileSystem.FileSystem.of({
        ...fs,
        utimes: (file, access, modified) =>
          fs
            .utimes(file, access, modified)
            .pipe(
              Effect.andThen(Queue.offer(timestamps, modified)),
              Effect.asVoid
            ),
      });

      yield* withLock(directory, "provision", hold).pipe(
        Effect.provideService(FileSystem.FileSystem, tracked),
        Effect.forkScoped
      );
      yield* Deferred.await(ready);

      for (let elapsed = 5000; elapsed <= 35_000; elapsed += 5000) {
        yield* TestClock.adjust("5 seconds");

        const modified = yield* TestClock.withLive(
          Queue.take(timestamps).pipe(Effect.timeout("2 seconds"))
        );

        expect(modified).toEqual(
          DateTime.toDate(DateTime.makeUnsafe(started + elapsed))
        );
      }

      const result = yield* TestClock.withLive(
        runCommand([
          process.execPath,
          "--input-type=module",
          "-e",
          contender,
          directory,
        ])
      );

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("busy");

      yield* Deferred.succeed(done, null);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  20_000
);
