import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import type * as Lease from "@rat-king/lexicon/runtime.lease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import { MailboxClientError, RatKingMailbox } from "@rat-king/mailbox-client";
import type { ConsumeOptions } from "@rat-king/mailbox-client";
import {
  Arbitrary,
  Clock,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";

import { recipientDid } from "../../../packages/envelope/test/helpers.ts";
import { consume } from "../../../packages/mailbox-client/src/consume.ts";
import {
  lockReader,
  readerLeaseJournal,
} from "../../../packages/ratking-client/src/reader-lease.ts";
import { LeaseAuthority, leaseLayer } from "../src/lease.ts";
import { testStoreFor } from "./helpers.ts";

const session = "restarting-reader";

const harness = {
  $type: "sh.mschf.ratking.runtime.lease#pi",
  sessionId: session,
} as const;

const outage = new MailboxClientError({
  error: "MailboxUnavailable",
  reason: "Injected outage",
});

const authority = Effect.fn("Test.openRestoredCell")(function* restoredCell(
  file: string
) {
  const { layer } = yield* testStoreFor(recipientDid, file);

  return yield* LeaseAuthority.pipe(
    Effect.provide(leaseLayer.pipe(Layer.provide(layer)))
  );
});

const clientError = (failure: {
  readonly error: string;
  readonly message?: string;
}) =>
  new MailboxClientError({
    error: failure.error,
    reason: failure.message ?? failure.error,
  });

it.effect.prop(
  "a restarted reader recovers the live tuple from restored cell storage after either acquire cut",
  [Arbitrary.schema(Schema.Literals(["restore-failed", "response-lost"]))],
  ([cut]) =>
    Effect.gen(function* restart() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const cell = `${root}/cell.sqlite`;
      const local = `${root}/reader`;

      const committed = yield* Effect.gen(function* beforeRestart() {
        const leases = yield* authority(cell);
        yield* lockReader(local, recipientDid, session);
        const journal = yield* readerLeaseJournal(local, recipientDid, session);
        const pending = yield* journal.pending(Option.none());

        const mailbox = yield* RatKingMailbox.pipe(
          Effect.provide(
            Layer.mock(RatKingMailbox, {
              lease: {
                acquire: (input) =>
                  leases
                    .acquire(Schema.decodeUnknownSync(Acquire.Input)(input))
                    .pipe(
                      Effect.mapError(clientError),
                      Effect.flatMap((lease) =>
                        cut === "response-lost"
                          ? Effect.fail(outage)
                          : Effect.succeed(lease)
                      )
                    ),
                release: () => Effect.fail(outage),
                renew: () => Effect.fail(outage),
                resolve: () =>
                  leases
                    .resolve(recipientDid)
                    .pipe(Effect.mapError(clientError)),
              },
            })
          )
        );

        const attempt = yield* consume(
          mailbox,
          recipientDid,
          () => Effect.void,
          {
            acquireAttempt: pending.attempt,
            harness,
            onAcquired: journal.save,
            onLease: () => Effect.fail(outage),
          }
        ).pipe(Effect.result);

        expect(Result.isFailure(attempt) && attempt.failure).toEqual(outage);

        return {
          lease: yield* leases.resolve(recipientDid),
          proof: pending.attempt,
        };
      }).pipe(Effect.scoped);

      const start = yield* Clock.currentTimeMillis;
      const leases = yield* authority(cell);
      expect(yield* leases.resolve(recipientDid)).toEqual(committed.lease);
      yield* lockReader(local, recipientDid, session);
      const journal = yield* readerLeaseJournal(local, recipientDid, session);
      const retry = yield* journal.pending(Option.none());

      if (cut === "response-lost") {
        expect(retry.attempt).toBe(committed.proof);
        expect(retry.resume).toBeUndefined();
      } else {
        expect(retry.attempt).not.toBe(committed.proof);
        expect(retry.resume).toEqual({
          generation: committed.lease.generation,
          leaseId: committed.lease.leaseId,
        });
      }

      const ready = yield* Deferred.make<Lease.MainValue>();

      const mailbox = yield* RatKingMailbox.pipe(
        Effect.provide(
          Layer.mock(RatKingMailbox, {
            lease: {
              acquire: (input) =>
                leases
                  .acquire(Schema.decodeUnknownSync(Acquire.Input)(input))
                  .pipe(Effect.mapError(clientError)),
              release: (input) =>
                leases
                  .release(Schema.decodeUnknownSync(Release.Input)(input))
                  .pipe(Effect.mapError(clientError)),
              renew: () => Effect.fail(outage),
              resolve: () =>
                leases.resolve(recipientDid).pipe(Effect.mapError(clientError)),
            },
            watch: () => Stream.never,
          })
        )
      );

      const options: ConsumeOptions = {
        acquireAttempt: retry.attempt,
        failOnHeld: true,
        harness,
        onAcquired: journal.save,
        onLease: (lease) => Deferred.succeed(ready, lease).pipe(Effect.asVoid),
      };

      if (retry.resume !== undefined) {
        Object.assign(options, {
          resume: { ...retry.resume, did: recipientDid },
        });
      }

      yield* consume(mailbox, recipientDid, () => Effect.void, options).pipe(
        Effect.forkScoped
      );
      const lease = yield* Deferred.await(ready);
      expect(lease.generation).toBe(committed.lease.generation);
      expect(lease.leaseId).toBe(committed.lease.leaseId);
      expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(10_000);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 } }
);

it.live(
  "a competing local process cannot open the reader lock until the holder exits",
  () =>
    Effect.gen(function* compete() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const moduleUrl = new URL(
        "../../../packages/ratking-client/src/reader-lease.ts",
        import.meta.url
      );

      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          "--input-type=module",
          "-e",
          `import { NodeServices } from '@effect/platform-node';
       import { Effect } from 'effect';
       import { lockReader } from ${JSON.stringify(moduleUrl.href)};
       await Effect.runPromise(lockReader(process.argv[1], process.argv[2], process.argv[3]).pipe(
         Effect.andThen(Effect.sync(() => { process.stdin.resume(); process.stdout.write('locked\\n'); })),
         Effect.andThen(Effect.never), Effect.scoped, Effect.provide(NodeServices.layer)));`,
          root,
          recipientDid,
          session,
        ])
      );

      const ready = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runHead
      );

      expect(ready).toEqual(Option.some("locked\n"));

      const contender = yield* lockReader(root, recipientDid, session).pipe(
        Effect.result
      );

      expect(Result.isFailure(contender) && contender.failure.error).toBe(
        "LocalReaderBusy"
      );
      yield* child.kill({ killSignal: "SIGKILL" });
      expect(Result.isFailure(yield* child.exitCode.pipe(Effect.result))).toBe(
        true
      );
      yield* lockReader(root, recipientDid, session);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
