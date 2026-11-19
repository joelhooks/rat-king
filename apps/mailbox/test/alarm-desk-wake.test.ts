import { promisify } from "node:util";

import { it } from "@effect/vitest";
import { Arbitrary, Console, Effect, Queue, Schema } from "effect";
import { TestClock } from "effect/testing";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import {
  healthy,
  recorder,
  settings,
} from "../../../packages/alchemy-nest/test/maintenance-fixtures.ts";
import { EncryptedEnvelope } from "../../../packages/lexicon/src/defs.ts";
import type { MailboxHealthValue } from "../../../packages/mailbox-client/src/health.ts";
import { wakeWanted } from "../../../stacks/nest/alarm-desk-wake.ts";
import {
  AlarmJournal,
  deskWakeReadings,
  emptyJournal,
  runAlarmCycle,
} from "../../../stacks/nest/alarm.ts";
import type { AlarmJournalValue } from "../../../stacks/nest/alarm.ts";
import { FleetError } from "../../../stacks/nest/stage-config.ts";

const now = 1_800_000_000_000;

const desk = "fixture-desk";

const key = `mail.wake/${desk}`;

const optedIn = { ...settings, wakeOnMail: [{ name: desk }] };

const captureConsole = (lines?: string[]) =>
  Effect.provideService(Console.Console, {
    ...console,
    log: (line: string) => {
      lines?.push(line);
    },
  });

const idOf = (message: number) => `222222222222${message}`;

const healthOf = (message: number, at: number): MailboxHealthValue => ({
  complete: true,
  lastAck: null,
  lease: null,
  oldestWake: null,
  oldestWakeSinceAck: {
    at,
    id: idOf(message),
    sender: "fixture-sender",
    seq: message,
  },
  quietUnacked: 0,
});

it.prop(
  "only an unacknowledged wake for a readerless, non-retired name qualifies",
  {
    offset: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 60_000, minimum: 1 }))
    ),
  },
  ({ offset }) => {
    const health = healthOf(2, now - offset);

    const lease = {
      expiresAt: now + offset,
      generation: 1,
      holder: "fixture-reader",
      pane: null,
    };

    expect(wakeWanted({ ...health, lease }, now)).toBeUndefined();
    expect(wakeWanted(health, now)).toBe(idOf(2));
    expect(
      wakeWanted(
        { ...health, lease: { ...lease, expiresAt: now - offset } },
        now
      )
    ).toBe(idOf(2));
    expect(
      wakeWanted({ ...health, oldestWakeSinceAck: null }, now)
    ).toBeUndefined();
    expect(wakeWanted({ ...health, retired: true }, now)).toBeUndefined();
  }
);

const TickSchema = Schema.Struct({
  enabled: Schema.Boolean,
  message: Schema.Literals([2, 3]),
  outcome: Schema.Literals(["failed", "accepted"]),
});

type Tick = typeof TickSchema.Type;

interface Model {
  attempts: number;
  elapsed: number;
  sent: Set<number>;
  waitingSince: number | undefined;
}

interface Real {
  journal: AlarmJournalValue;
  readonly sealed: Map<string, string>;
  readonly queue: Queue.Queue<Effect.Effect<void>>;
}

const sealed = (serial: number) =>
  Schema.decodeSync(EncryptedEnvelope)({
    aad: {
      messageId: idOf(serial),
      recipientDid: "did:web:recipient.invalid",
      recipientKeyId: "did:web:recipient.invalid#encryption",
      senderDid: "did:web:sender.invalid",
    },
    ciphertext: { $bytes: "AQ==" },
    enc: { $bytes: "AQ==" },
    suite: { aeadId: 0, kdfId: 0, kemId: 0 },
    version: 1,
  });

const JournalJson = Schema.fromJsonString(AlarmJournal);

const step = Effect.fn("Test.deskWakeTick")(function* step(
  tick: Tick,
  model: Model,
  real: Real
) {
  const { pages, ports } = recorder();
  const sends: string[] = [];
  let checkpoint = real.journal;
  const at = now + model.elapsed * 60_000;
  const messageId = idOf(tick.message);
  const shouldSend = tick.enabled && !model.sent.has(tick.message);

  yield* TestClock.setTime(at);

  real.journal = yield* runAlarmCycle(
    real.journal,
    Effect.succeed(healthy),
    Effect.succeed([{ health: healthOf(tick.message, now), name: desk }]),
    tick.enabled ? optedIn : settings,
    {
      ...ports,
      deskWake: {
        prepare: (recipient, record) =>
          Effect.sync(() => {
            expect(recipient).toBe("mischief/worker");
            expect(record).toMatchObject({
              messageId,
              name: desk,
              seq: tick.message,
              wake: true,
            });
            expect(Date.parse(record.recordedAt)).toBe(now);

            const envelope = sealed(real.sealed.size + 4);

            expect(real.sealed.has(messageId)).toBe(false);
            real.sealed.set(messageId, envelope.aad.messageId);

            return { envelope, recipient };
          }),
        send: (delivery) =>
          Effect.suspend(() => {
            expect(delivery.envelope.aad.messageId).toBe(
              real.sealed.get(messageId)
            );
            expect(
              checkpoint.wakeOnMail?.pending[messageId]?.envelope.aad.messageId
            ).toBe(delivery.envelope.aad.messageId);
            sends.push(messageId);

            return tick.outcome === "accepted"
              ? Effect.void
              : Effect.fail(
                  new FleetError({ reason: "Fixture send unavailable" })
                );
          }),
      },
      save: (journal) =>
        Effect.sync(() => {
          checkpoint = journal;
        }),
    }
  );

  expect(sends).toEqual(shouldSend ? [messageId] : []);
  expect(pages).toEqual([]);

  if (tick.enabled) {
    model.waitingSince ??= at;

    if (shouldSend) {
      model.attempts += 1;

      if (tick.outcome === "accepted") {
        model.sent.add(tick.message);
      }
    }

    const warned = model.attempts >= 3 && at - model.waitingSince > 30 * 60_000;

    expect(real.journal.alarms[key]?.value === "firing").toBe(warned);

    if (warned) {
      expect(real.journal.alarms[key]?.context.severity).toBe("warn");
    }
  }

  const encoded = yield* Schema.encodeEffect(JournalJson)(checkpoint);

  real.journal = yield* Schema.decodeEffect(JournalJson)(encoded);
  model.elapsed += 16;
});

const action = (tick: Tick): AsyncCommand<Model, Real> => ({
  check: () => true,
  run: promisify(
    (model: Model, real: Real, complete: (problem: Error | null) => void) => {
      Queue.offerUnsafe(
        real.queue,
        step(tick, model, real).pipe(
          Effect.matchCause({
            onFailure: (cause) => {
              complete(new Error("Model command failed", { cause }));
            },
            onSuccess: () => {
              complete(null);
            },
          })
        )
      );
    }
  ),
  toString: () => JSON.stringify(tick),
});

it.effect.prop(
  "desk wake retries the same envelope after failure, survives journal reload and warns without paging",
  {
    ticks: Arbitrary.schema(
      Schema.Array(TickSchema).check(Schema.isMaxLength(12))
    ),
  },
  ({ ticks }) =>
    Effect.gen(function* test() {
      const queue = yield* Queue.unbounded<Effect.Effect<void>>();

      yield* Effect.forever(Queue.take(queue).pipe(Effect.flatten)).pipe(
        Effect.forkScoped
      );

      const real = {
        journal: emptyJournal,
        queue,
        sealed: new Map<string, string>(),
      };

      const model = {
        attempts: 0,
        elapsed: 0,
        sent: new Set<number>(),
        waitingSince: undefined,
      };

      const first: Tick = { enabled: true, message: 2, outcome: "failed" };

      const commands = [
        { ...first, enabled: false },
        first,
        first,
        { ...first, outcome: "accepted" as const },
        { ...first, message: 3 as const },
        first,
        ...ticks,
      ].map(action);

      yield* Effect.promise(
        asyncModelRun.bind(undefined, () => ({ model, real }), commands)
      );
    }).pipe(captureConsole(), Effect.scoped)
);

const serial = Schema.Literals([2, 3, 4, 5, 6, 7]);

it.effect.prop(
  "checkpoints a desk wake before its deadline even when the bulk sweep never returns",
  [serial, Schema.Int.check(Schema.isBetween({ maximum: 14_000, minimum: 1 }))],
  ([message, delay]) =>
    Effect.gen(function* test() {
      const { ports } = recorder();
      const sent: string[] = [];
      let checkpoint = emptyJournal;
      let sweeping = false;

      yield* TestClock.setTime(now);

      yield* runAlarmCycle(
        emptyJournal,
        Effect.sync(() => {
          sweeping = true;
        }).pipe(Effect.andThen(Effect.never)),
        Effect.sleep(delay).pipe(
          Effect.as([{ health: healthOf(message, now), name: desk }])
        ),
        optedIn,
        {
          ...ports,
          deskWake: {
            prepare: (recipient, record) =>
              Effect.succeed({ envelope: sealed(message), recipient }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    expect(record.messageId).toBe(idOf(message));
                  })
                )
              ),
            send: ({ envelope }) =>
              Effect.sync(() => {
                sent.push(envelope.aad.messageId);
              }),
          },
          save: (journal) =>
            Effect.sync(() => {
              checkpoint = journal;
            }),
        }
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust(delay + 1);

      expect(sweeping).toBe(true);
      expect(sent).toEqual([idOf(message)]);
      expect(checkpoint.wakeOnMail?.sent).toEqual(sent);
    }).pipe(captureConsole(), Effect.scoped)
);

it.effect.prop(
  "unavailable desk health persists unknown evidence and never replays pending mail",
  [serial, Schema.Boolean],
  ([message, partial]) =>
    Effect.gen(function* test() {
      const { ports } = recorder();

      const pending = {
        [idOf(message)]: {
          envelope: sealed(message),
          recipient: "fixture-waker",
        },
      };

      const prior = {
        ...emptyJournal,
        wakeOnMail: {
          pending,
          readings: { [key]: { status: "ok" as const } },
          sent: [],
          waiting: {},
        },
      };

      const journal = yield* runAlarmCycle(
        prior,
        Effect.succeed(healthy),
        Effect.succeed(partial ? [{ health: null, name: desk }] : null),
        optedIn,
        {
          ...ports,
          deskWake: {
            prepare: () => Effect.die("unread desk must not prepare"),
            send: () => Effect.die("unread desk must not send"),
          },
        }
      );

      const encoded = yield* Schema.encodeEffect(JournalJson)(journal);
      const reloaded = yield* Schema.decodeEffect(JournalJson)(encoded);

      expect(deskWakeReadings(reloaded, optedIn)[key]).toEqual({
        evidence: "Desk wake nameHealth read unavailable",
        status: "unknown",
      });
      expect(reloaded.wakeOnMail?.pending).toEqual(pending);
    }).pipe(captureConsole())
);

const actions = [
  "prepare_failed",
  "send_failed",
  "sent",
  "read_unavailable",
] as const;

const logLine = (event: string, reason?: string) =>
  JSON.stringify({ action: event, name: desk, reason, source: "desk_wake" });

it.effect.prop(
  "logs each desk wake action with a safe reason and no record fields",
  [serial],
  ([message]) =>
    Effect.gen(function* test() {
      const { ports } = recorder();
      const logs: string[] = [];
      const failure = new FleetError({ reason: "Fixture unavailable" });

      for (const outcome of actions) {
        yield* runAlarmCycle(
          emptyJournal,
          Effect.succeed(healthy),
          Effect.succeed(
            outcome === "read_unavailable"
              ? null
              : [{ health: healthOf(message, now), name: desk }]
          ),
          optedIn,
          {
            ...ports,
            deskWake: {
              prepare: (recipient) =>
                outcome === "prepare_failed"
                  ? Effect.fail(failure)
                  : Effect.succeed({ envelope: sealed(message), recipient }),
              send: () =>
                outcome === "send_failed" ? Effect.fail(failure) : Effect.void,
            },
          }
        ).pipe(captureConsole(logs));
      }

      expect(logs).toEqual([
        logLine("wanted"),
        logLine("prepare_failed", failure.reason),
        logLine("wanted"),
        logLine("send_failed", failure.reason),
        logLine("wanted"),
        logLine("sent"),
        logLine("read_unavailable", "Desk wake nameHealth read unavailable"),
      ]);
    })
);
