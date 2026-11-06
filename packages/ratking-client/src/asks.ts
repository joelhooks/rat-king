import { Effect, Option, Schema, Semaphore } from "effect";
import { createMachine, transition } from "xstate";

import type { Inbound } from "./payload.ts";

export const askLifecycle = createMachine({
  context: {},
  id: "ask",
  initial: "pending",
  states: {
    answered: { on: { ack: { target: "closed" } } },
    closed: { type: "final" },
    nudged: {
      on: { ack: { target: "closed" }, reply: { target: "answered" } },
    },
    pending: {
      on: {
        ack: { target: "closed" },
        due: { target: "nudged" },
        reply: { target: "answered" },
      },
    },
  },
});

export const PendingAsk = Schema.Struct({
  did: Schema.String,
  dueBy: Schema.optionalKey(Schema.Finite),
  id: Schema.String,
  sentAt: Schema.Finite,
  state: Schema.Literals(["pending", "nudged", "answered", "closed"]),
  summary: Schema.String,
  to: Schema.String,
});

export type PendingAskValue = typeof PendingAsk.Type;

export const AskJournal = Schema.Array(PendingAsk);

export const CLOSED_ASK_HISTORY = 200;

const compact = (entries: readonly PendingAskValue[]) => {
  const closed = entries.filter((entry) => entry.state === "closed");
  const retained = new Set(closed.slice(-CLOSED_ASK_HISTORY));

  return entries.filter(
    (entry) => entry.state !== "closed" || retained.has(entry)
  );
};

export interface AskPorts<E> {
  readonly load: Effect.Effect<readonly PendingAskValue[], E>;
  readonly now: Effect.Effect<number>;
  readonly save: (asks: readonly PendingAskValue[]) => Effect.Effect<void, E>;
}

export interface AsksApi<E> {
  readonly reload: Effect.Effect<void, E>;
  readonly ack: (id: string) => Effect.Effect<void, E>;
  readonly match: (
    inbound: Inbound
  ) => Effect.Effect<Option.Option<PendingAskValue>, E>;
  readonly nudges: Effect.Effect<readonly PendingAskValue[], E>;
  readonly pending: Effect.Effect<readonly PendingAskValue[]>;
  readonly record: (ask: PendingAskValue) => Effect.Effect<void, E>;
}

export const openAsks = <E>(ports: AskPorts<E>) =>
  Effect.gen(function* openAskJournal() {
    const lock = yield* Semaphore.make(1);
    const loaded = yield* ports.load;
    let entries = compact(loaded);

    if (entries.length !== loaded.length) {
      yield* ports.save(entries);
    }

    const record = (ask: PendingAskValue) => {
      const next = compact([
        ...entries.filter((entry) => entry.id !== ask.id),
        ask,
      ]);

      return ports.save(next).pipe(
        Effect.andThen(
          Effect.sync(() => {
            entries = next;
          })
        )
      );
    };

    const advance = (ask: PendingAskValue, event: "ack" | "due" | "reply") => {
      const [next] = transition(
        askLifecycle,
        askLifecycle.resolveState({ context: {}, value: ask.state }),
        { type: event }
      );

      const state = Schema.decodeUnknownSync(PendingAsk.fields.state)(
        next.value
      );

      return record({ ...ask, state });
    };

    return {
      ack: (id) =>
        lock.withPermits(1)(
          Effect.gen(function* acknowledgeAsk() {
            const ask = entries.find(
              (entry) => entry.id === id && entry.state !== "closed"
            );

            if (ask !== undefined) {
              yield* advance(ask, "ack");
            }
          })
        ),
      match: (inbound) =>
        lock.withPermits(1)(
          Effect.gen(function* receiveReply() {
            const ask = inbound.replyTo.pipe(
              Option.flatMap((id) =>
                Option.fromNullishOr(
                  entries.find(
                    (entry) =>
                      entry.id === id &&
                      entry.did === inbound.did &&
                      entry.state !== "closed"
                  )
                )
              )
            );

            if (Option.isSome(ask)) {
              yield* advance(ask.value, "reply");
            }

            return ask;
          })
        ),
      nudges: lock.withPermits(1)(
        Effect.gen(function* overdueAsks() {
          const now = yield* ports.now;

          const overdue = entries.filter(
            (entry) =>
              entry.state === "pending" &&
              entry.dueBy !== undefined &&
              entry.dueBy <= now
          );

          for (const ask of overdue) {
            yield* advance(ask, "due");
          }

          return overdue;
        })
      ),
      pending: Effect.sync(() =>
        entries.filter((entry) => entry.state !== "closed")
      ),
      record: (ask) => lock.withPermits(1)(Effect.suspend(() => record(ask))),
      reload: lock.withPermits(1)(
        Effect.gen(function* reloadAsks() {
          entries = compact(yield* ports.load);
        })
      ),
    } satisfies AsksApi<E>;
  });

export const askAge = (ask: PendingAskValue, now: number) =>
  `${Math.max(0, Math.floor((now - ask.sentAt) / 60_000))} min`;
