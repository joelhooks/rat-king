import { DateTime, Effect, Option, Schema } from "effect";

import { EncryptedEnvelope } from "../../packages/lexicon/src/defs.ts";
import * as Wake from "../../packages/lexicon/src/desk.wake.ts";
import type { MailboxHealthValue } from "../../packages/mailbox-client/src/health.ts";
import type { AlarmReadingValue, AlarmSettingsValue } from "./alarm-config.ts";
import type { WakeSighting } from "./alarm-wakes.ts";
import type { FleetError } from "./stage-config.ts";

const Pending = Schema.Struct({
  envelope: EncryptedEnvelope,
  recipient: Schema.String,
});

const Wait = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  since: Schema.Finite,
});

export const DeskWakeState = Schema.Struct({
  pending: Schema.Record(Schema.String, Pending),
  sent: Schema.Array(Schema.String),
  waiting: Schema.Record(Schema.String, Wait),
});

type State = typeof DeskWakeState.Type;

export type PendingWake = typeof Pending.Type;

export interface DeskWakePorts<R> {
  readonly prepare: (
    waker: string,
    record: typeof Wake.Main.Encoded
  ) => Effect.Effect<PendingWake, FleetError, R>;
  readonly send: (pending: PendingWake) => Effect.Effect<void, FleetError, R>;
}

export const wakeWanted = (health: MailboxHealthValue | null, now: number) =>
  health === null ||
  health.retired === true ||
  (health.lease !== null && health.lease.expiresAt > now)
    ? undefined
    : health.oldestWakeSinceAck?.id;

const recordOf = (
  name: string,
  wake: NonNullable<MailboxHealthValue["oldestWakeSinceAck"]>
): typeof Wake.Main.Encoded => ({
  $type: Wake.RecordMetadata.collection,
  messageId: wake.id,
  name,
  recordedAt: DateTime.formatIso(DateTime.makeUnsafe(wake.at)),
  ...(wake.seq === undefined ? undefined : { seq: wake.seq }),
  wake: true,
});

const readingOf = (wait: typeof Wait.Type, now: number): AlarmReadingValue =>
  wait.attempts >= 3 && now - wait.since > 30 * 60_000
    ? {
        evidence: `Desk still needs waking after ${wait.attempts} send attempts`,
        severity: "warn",
        status: "firing",
      }
    : { status: "ok" };

const inspectDesks = (
  configured: NonNullable<AlarmSettingsValue["wakeOnMail"]>,
  sightings: readonly (typeof WakeSighting.Type)[] | null | undefined,
  state: State,
  now: number
) => {
  const seen = new Map(sightings?.map(({ name, health }) => [name, health]));
  const sent = new Set(state.sent);
  const priorWaiting = new Map(Object.entries(state.waiting));
  const waiting = new Map<string, typeof Wait.Type>();
  const readings: Record<string, AlarmReadingValue> = {};

  const requests = new Map<
    string,
    { name: string; record: typeof Wake.Main.Encoded; waker: string }
  >();

  for (const [name, waker] of new Map(
    configured.map((desk) => [desk.name, desk.waker])
  )) {
    const health = seen.get(name) ?? null;
    const wake = health?.oldestWakeSinceAck ?? null;
    const id = wakeWanted(health, now);

    if (id !== undefined && wake !== null) {
      waiting.set(name, priorWaiting.get(name) ?? { attempts: 0, since: now });

      if (!sent.has(id) && !requests.has(id)) {
        requests.set(id, {
          name,
          record: recordOf(name, wake),
          waker: waker ?? "mischief/worker",
        });
      }
    } else if (health === null) {
      const previous = priorWaiting.get(name);

      if (previous !== undefined) {
        waiting.set(name, previous);
      }

      readings[`mail.wake/${name}`] = { status: "unknown" };
    } else {
      readings[`mail.wake/${name}`] = { status: "ok" };
    }
  }

  return { readings, requests, waiting };
};

export const collectDeskWake = Effect.fn("Alarm.collectDeskWake")(
  function* collectDeskWake<R>(
    configured: NonNullable<AlarmSettingsValue["wakeOnMail"]>,
    sightings: readonly (typeof WakeSighting.Type)[] | null | undefined,
    prior: State | undefined,
    now: number,
    ports: DeskWakePorts<R>,
    save: (state: State) => Effect.Effect<void, FleetError, R>,
    unavailable: Effect.Effect<void, never, R>
  ) {
    const state = prior ?? { pending: {}, sent: [], waiting: {} };

    const { readings, requests, waiting } = inspectDesks(
      configured,
      sightings,
      state,
      now
    );

    const pending = new Map(Object.entries(state.pending));
    const sent = new Set(state.sent);

    const prepared = yield* Effect.forEach(
      requests,
      ([id, request]) => {
        const existing = pending.get(id);

        return (
          existing === undefined
            ? ports.prepare(request.waker, request.record).pipe(Effect.option)
            : Effect.succeedSome(existing)
        ).pipe(
          Effect.map((delivery) => ({ delivery, id, name: request.name }))
        );
      },
      { concurrency: "unbounded" }
    );

    const attempts = prepared.flatMap(({ delivery, id, name }) =>
      Option.isSome(delivery) ? [{ delivery: delivery.value, id, name }] : []
    );

    for (const { delivery, id, name } of attempts) {
      pending.set(id, delivery);

      const wait = waiting.get(name) ?? { attempts: 0, since: now };

      waiting.set(name, { ...wait, attempts: wait.attempts + 1 });
    }

    if (attempts.length > 0) {
      yield* save({
        pending: Object.fromEntries(pending),
        sent: state.sent,
        waiting: Object.fromEntries(waiting),
      });
    }

    const outcomes = yield* Effect.forEach(
      attempts,
      ({ delivery, id }) =>
        ports.send(delivery).pipe(
          Effect.isSuccess,
          Effect.map((ok) => ({ id, ok }))
        ),
      { concurrency: "unbounded" }
    );

    for (const { id, ok } of outcomes) {
      if (ok) {
        sent.add(id);
        pending.delete(id);
      }
    }

    if (prepared.length !== attempts.length || outcomes.some(({ ok }) => !ok)) {
      yield* unavailable;
    }

    for (const [name, wait] of waiting) {
      readings[`mail.wake/${name}`] ??= readingOf(wait, now);
    }

    return {
      readings,
      state: {
        pending: Object.fromEntries(pending),
        sent: [...sent],
        waiting: Object.fromEntries(waiting),
      },
    };
  }
);
