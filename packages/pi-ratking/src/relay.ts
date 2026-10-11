import { Effect, Option, Schema, Semaphore } from "effect";
import { createMachine, transition } from "xstate";

import type { RelaySettingValue } from "./config.ts";
import { Kind } from "./payload.ts";
import type { Inbound, LexiconRecordValue } from "./payload.ts";

export const RelayRecord = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.relay#message"),
  body: Schema.String,
  cc: Schema.Boolean,
  did: Schema.String,
  encrypted: Schema.Boolean,
  from: Schema.String,
  id: Schema.String,
  kind: Kind,
  label: Schema.NullOr(Schema.String),
  replyTo: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  verified: Schema.Boolean,
});

export const RelayHandled = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.relay#handled"),
  id: Schema.String,
});

export const relayRecord = (
  inbound: Inbound,
  encrypted: boolean
): typeof RelayRecord.Type => ({
  $type: "sh.mschf.ratking.relay#message",
  body: inbound.body,
  cc: inbound.cc,
  did: inbound.did,
  encrypted,
  from: inbound.from,
  id: inbound.id,
  kind: inbound.kind,
  label: Option.getOrNull(inbound.label),
  replyTo: Option.getOrNull(inbound.replyTo),
  summary: Option.getOrNull(inbound.summary),
  verified: inbound.verified,
});

export const relayedInbound = (record: typeof RelayRecord.Type): Inbound => ({
  body: record.body,
  cc: record.cc,
  did: record.did,
  from: record.from,
  id: record.id,
  kind: record.kind,
  label: Option.fromNullishOr(record.label),
  replyTo: Option.fromNullishOr(record.replyTo),
  summary: Option.fromNullishOr(record.summary),
  verified: record.verified,
});

export const relayLifecycle = createMachine({
  context: {},
  id: "relay",
  initial: "pending",
  states: {
    handled: { type: "final" },
    injected: { type: "final" },
    pending: {
      on: { fallback: { target: "injected" }, handled: { target: "handled" } },
    },
  },
});

export const RelayEntry = Schema.Struct({
  due: Schema.Finite,
  record: RelayRecord,
  settled: Schema.Boolean,
  state: Schema.Literals(["pending", "handled", "injected"]),
});

export const RelayJournal = Schema.Array(RelayEntry);

export type RelayEntryValue = typeof RelayEntry.Type;

export interface RelayPorts<E> {
  readonly now: Effect.Effect<number>;
  readonly load: Effect.Effect<readonly RelayEntryValue[], E>;
  readonly save: (
    entries: readonly RelayEntryValue[]
  ) => Effect.Effect<void, E>;
  readonly inject: (inbound: Inbound, settled: boolean) => Effect.Effect<void>;
}

export const openRelay = <E>(config: RelaySettingValue, ports: RelayPorts<E>) =>
  Effect.gen(function* acquireRouter() {
    const mutex = yield* Semaphore.make(1);

    const entries = new Map(
      (yield* ports.load).map((entry) => [entry.record.id, entry])
    );

    const saveEntry = (entry: RelayEntryValue) =>
      ports
        .save([
          ...[...entries.values()].filter(
            (current) => current.record.id !== entry.record.id
          ),
          entry,
        ])
        .pipe(
          Effect.andThen(
            Effect.sync(() => {
              entries.set(entry.record.id, entry);
            })
          )
        );

    const finish = (entry: RelayEntryValue, event: "handled" | "fallback") =>
      Effect.gen(function* finishEntry() {
        const [next] = transition(
          relayLifecycle,
          relayLifecycle.resolveState({ context: {}, value: entry.state }),
          { type: event }
        );

        if (next.value === entry.state) {
          return;
        }

        if (next.matches("injected")) {
          const inbound = relayedInbound(entry.record);
          yield* ports.inject(
            { ...inbound, body: `[staff did not handle]\n${inbound.body}` },
            entry.settled
          );
        }

        yield* saveEntry({
          ...entry,
          state: next.matches("handled") ? "handled" : "injected",
        });
      });

    const relay = {
      failed: (id: string) =>
        mutex.withPermit(
          Effect.gen(function* failed() {
            const entry = entries.get(id);

            if (entry !== undefined) {
              yield* finish(entry, "fallback");
            }
          })
        ),
      handled: (id: string) =>
        mutex.withPermit(
          Effect.gen(function* handled() {
            const entry = entries.get(id);

            if (entry !== undefined) {
              yield* finish(entry, "handled");
            }
          })
        ),
      receive: (
        inbound: Inbound,
        settled: boolean,
        encrypted: boolean,
        now: number
      ) =>
        mutex.withPermit(
          Effect.gen(function* receive() {
            if (inbound.verified && inbound.from === config.to) {
              yield* ports.inject(inbound, settled);

              return Option.none<LexiconRecordValue>();
            }

            if (inbound.kind === "data") {
              yield* ports.inject(inbound, settled);

              return Option.none<LexiconRecordValue>();
            }

            const record = relayRecord(inbound, encrypted);

            if (config.mode === "copy") {
              yield* ports.inject(inbound, settled);

              return Option.some<LexiconRecordValue>(record);
            }

            if (entries.has(inbound.id)) {
              return Option.none<LexiconRecordValue>();
            }

            yield* saveEntry({
              due: now + config.fallbackMinutes * 60_000,
              record,
              settled,
              state: "pending",
            });

            return Option.some<LexiconRecordValue>(record);
          })
        ),
      recover: (now: number) =>
        mutex.withPermit(
          Effect.gen(function* recover() {
            for (const entry of entries.values()) {
              if (entry.state === "pending" && entry.due <= now) {
                yield* finish(entry, "fallback");
              }
            }
          })
        ),
    };

    yield* relay.recover(yield* ports.now);

    return relay;
  });
