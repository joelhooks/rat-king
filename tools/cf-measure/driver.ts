import {
  Clock,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Schedule,
  Schema,
} from "effect";

import type * as Defs from "../../packages/lexicon/src/defs.ts";
import { consume } from "../../packages/mailbox-client/src/consume.ts";
import {
  layer,
  RatKingMailbox,
} from "../../packages/mailbox-client/src/index.ts";
import type { MailboxClientError } from "../../packages/mailbox-client/src/index.ts";
import type { Inputs } from "./identities.ts";
import { classify, MeasureError, summarize } from "./model.ts";
import type { Event, Timing } from "./model.ts";

export interface DriverOptions {
  readonly readers: number;
  readonly seconds: number;
  readonly perDay: number;
  readonly burst: number;
  readonly drainSeconds: number;
}

export interface DriverPort {
  readonly send: (
    from: number,
    to: number,
    body: string
  ) => Effect.Effect<void, MailboxClientError>;
  readonly read: (
    index: number,
    ready: Effect.Effect<void>,
    receive: (
      body: string,
      ack: Effect.Effect<void, MailboxClientError>
    ) => Effect.Effect<void, MailboxClientError | MeasureError>
  ) => Effect.Effect<void, MailboxClientError | MeasureError>;
}

export const mailboxPort = Effect.fn("Measure.mailboxPort")(
  function* mailboxPort(
    baseUrl: string,
    inputs: typeof Inputs.Type,
    documents: readonly Defs.DidDocumentValue[],
    onEvent: (event: Event) => Effect.Effect<void>
  ) {
    const mailboxes = yield* Effect.all(
      inputs.readers.map((identity) =>
        RatKingMailbox.pipe(
          Effect.provide(
            layer({
              documents,
              endpoint: baseUrl,
              identity,
              serviceDid: inputs.service.did,
            })
          )
        )
      )
    );

    const get = (index: number) => {
      const mailbox = mailboxes[index];

      if (mailbox === undefined) {
        throw new Error("Reader index outside validated range");
      }

      return mailbox;
    };

    return {
      read: (index, ready, receive) =>
        consume<MailboxClientError | MeasureError, never>(
          get(index),
          inputs.readers[index]?.did ?? "",
          (message, meta) => receive(message.body, meta.ack),
          {
            ackOnReturn: false,
            failOnHeld: true,
            harness: { $type: "sh.mschf.ratking.runtime.lease#pi" },
            onLease: (lease) =>
              onEvent({
                expiresAt: lease.expiresAt,
                generation: lease.generation,
                index,
                kind: "lease",
              }).pipe(Effect.andThen(ready)),
            onRetryMetric: (tag) => onEvent({ index, kind: "retry", tag }),
            onSkip: (skip) =>
              onEvent({ index, kind: "skip", reason: skip.reason }),
          }
        ),
      send: (from, to, body) =>
        get(from)
          .send(inputs.readers[to]?.did ?? "", body, {
            encrypt: true,
            wakeReason: "quiet",
            woke: false,
          })
          .pipe(Effect.asVoid),
    } satisfies DriverPort;
  }
);

const Payload = Schema.Struct({ id: Schema.String, run: Schema.String });

const now = Clock.currentTimeNanos.pipe(
  Effect.map((nanos) => Number(nanos) / 1_000_000)
);

export const drive = Effect.fn("Measure.drive")(function* drive(
  options: DriverOptions,
  port: DriverPort,
  emit: (event: Event) => Effect.Effect<void>
) {
  if (
    !Number.isSafeInteger(options.readers) ||
    options.readers < 2 ||
    !Number.isFinite(options.seconds) ||
    options.seconds <= 0 ||
    options.seconds > 86_400 ||
    !Number.isFinite(options.perDay) ||
    options.perDay < 0 ||
    !Number.isSafeInteger(options.burst) ||
    options.burst < 1 ||
    options.burst > 1000 ||
    !Number.isFinite(options.drainSeconds) ||
    options.drainSeconds < 0 ||
    options.drainSeconds >= options.seconds
  ) {
    return yield* new MeasureError({
      reason:
        "Invalid driver bounds (2+ readers, 0 < duration <= 24h, nonnegative rate, 1..1000 burst, drain < duration)",
    });
  }

  const random = yield* Crypto.Crypto;
  const run = yield* random.randomUUIDv4();
  const timings = new Map<string, Timing>();
  const errors: Record<string, number> = {};
  let sequence = 0;

  const recordError = (
    operation: string,
    error: MailboxClientError | MeasureError
  ) =>
    Effect.gen(function* emitError() {
      const tag = classify(error);

      errors[tag] = (errors[tag] ?? 0) + 1;
      yield* emit({ kind: "error", operation, tag, time: yield* now });
    });

  const receive = (index: number) =>
    Effect.fn("Measure.receive")(function* receiveMessage(
      body: string,
      ack: Effect.Effect<void, MailboxClientError>
    ) {
      const received = yield* now;

      const payload = yield* Schema.decodeEffect(
        Schema.fromJsonString(Payload)
      )(body).pipe(
        Effect.mapError(
          () => new MeasureError({ reason: "Unexpected test payload" })
        )
      );

      const timing = timings.get(payload.id);

      if (payload.run !== run || timing === undefined) {
        return yield* new MeasureError({
          reason: "Foreign test message; use fresh identities per run",
        });
      }

      timings.set(payload.id, { ...timing, received });
      yield* emit({ id: payload.id, index, kind: "received", time: received });
      const ackStarted = yield* now;

      yield* ack.pipe(Effect.tapError((error) => recordError("ack", error)));
      const acked = yield* now;
      const latest = timings.get(payload.id) ?? timing;

      timings.set(payload.id, { ...latest, ackStarted, acked });

      return yield* emit({
        ackMs: acked - ackStarted,
        id: payload.id,
        kind: "acked",
        time: acked,
      });
    });

  const send = Effect.gen(function* send() {
    const id = `${sequence}`;
    const to = sequence % options.readers;
    const from = (to + 1) % options.readers;

    sequence += 1;
    yield* emit({ from, id, kind: "attempt", time: yield* now, to });
    const started = yield* now;

    timings.set(id, { id, started });
    yield* port.send(from, to, JSON.stringify({ id, run })).pipe(
      Effect.flatMap(() =>
        Effect.gen(function* acceptSend() {
          const accepted = yield* now;
          const latest = timings.get(id) ?? { id, started };

          timings.set(id, { ...latest, accepted });
          yield* emit({
            id,
            kind: "accepted",
            sendMs: accepted - started,
            time: accepted,
          });
        })
      ),
      Effect.catch((error) => recordError("send", error))
    );
  });

  const burst = Effect.forEach(
    Array.from({ length: options.burst }),
    () => send,
    { concurrency: options.burst, discard: true }
  );

  const sending =
    options.perDay === 0
      ? Effect.never
      : burst.pipe(
          Effect.repeat(
            Schedule.fixed((86_400_000 * options.burst) / options.perDay)
          ),
          Effect.asVoid
        );

  const startedAt = yield* Clock.currentTimeMillis;

  yield* emit({
    kind: "start",
    options: { ...options },
    run,
    startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
  });

  return yield* Effect.scoped(
    Effect.gen(function* runDriver() {
      const readers = yield* Effect.forEach(
        Array.from({ length: options.readers }),
        (_, index) =>
          Effect.gen(function* startReader() {
            const ready = yield* Deferred.make<boolean>();

            const fiber = yield* port
              .read(
                index,
                Deferred.succeed(ready, true).pipe(Effect.asVoid),
                receive(index)
              )
              .pipe(Effect.forkScoped);

            return { fiber, ready };
          })
      );

      const healthy = Effect.forEach(
        readers,
        ({ fiber }) => Fiber.join(fiber),
        { concurrency: "unbounded", discard: true }
      ).pipe(
        Effect.andThen(
          Effect.fail(
            new MeasureError({ reason: "Readers stopped before the deadline" })
          )
        ),
        Effect.tapError((error) => recordError("reader", error))
      );

      const workload = Effect.gen(function* workload() {
        yield* Effect.forEach(readers, ({ ready }) => Deferred.await(ready), {
          concurrency: "unbounded",
          discard: true,
        });
        yield* sending.pipe(
          Effect.raceFirst(
            Effect.sleep((options.seconds - options.drainSeconds) * 1000)
          )
        );
        yield* Effect.sleep(options.drainSeconds * 1000);
      });

      const deadline = Effect.sleep(options.seconds * 1000).pipe(
        Effect.andThen(
          Effect.forEach(readers, ({ ready }) => Deferred.isDone(ready), {
            concurrency: "unbounded",
          })
        ),
        Effect.flatMap((ready) =>
          ready.every(Boolean)
            ? Effect.void
            : new MeasureError({
                reason:
                  "Measurement deadline reached before every reader acquired a lease",
              })
        ),
        Effect.tapError((error) => recordError("deadline", error))
      );

      yield* workload.pipe(
        Effect.raceFirst(healthy),
        Effect.raceFirst(deadline)
      );
    })
  ).pipe(
    Effect.ensuring(
      Effect.gen(function* finish() {
        const finishedAt = yield* Clock.currentTimeMillis;

        for (const timing of timings.values()) {
          yield* emit({ kind: "message", ...timing });
        }

        yield* emit({
          finishedAt: DateTime.formatIso(DateTime.makeUnsafe(finishedAt)),
          kind: "summary",
          run,
          startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
          ...summarize([...timings.values()], errors),
        });
      })
    )
  );
});
