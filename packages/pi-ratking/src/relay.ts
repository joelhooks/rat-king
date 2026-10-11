import { Effect, Option, Schema, Semaphore } from "effect";
import { createMachine, transition } from "xstate";

import type { RelaySettingValue } from "./config.ts";
import { Kind } from "./payload.ts";
import type { Inbound, InboundRecord, LexiconRecordValue } from "./payload.ts";

export const RelayRecord = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.relay#message"),
  body: Schema.String,
  cc: Schema.Boolean,
  ccNames: Schema.optionalKey(Schema.Array(Schema.String)),
  did: Schema.String,
  encrypted: Schema.Boolean,
  from: Schema.String,
  id: Schema.String,
  kind: Kind,
  label: Schema.NullOr(Schema.String),
  replyTo: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  thread: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  verified: Schema.Boolean,
});

export const RelayHandled = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.relay#handled"),
  id: Schema.String,
});

export const relayRecord = (
  inbound: Inbound,
  encrypted: boolean
): typeof RelayRecord.Type => {
  const record: typeof RelayRecord.Type = {
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
  };

  if (inbound.ccNames !== undefined) {
    Object.assign(record, { ccNames: inbound.ccNames });
  }

  if (inbound.thread !== undefined) {
    Object.assign(record, { thread: inbound.thread });
  }

  if (inbound.to !== undefined) {
    Object.assign(record, { to: inbound.to });
  }

  return record;
};

export const relayedInbound = (record: typeof RelayRecord.Type): Inbound => {
  const inbound: Inbound = {
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
  };

  if (record.ccNames !== undefined) {
    Object.assign(inbound, { ccNames: record.ccNames });
  }

  if (record.thread !== undefined) {
    Object.assign(inbound, { thread: record.thread });
  }

  if (record.to !== undefined) {
    Object.assign(inbound, { to: record.to });
  }

  return inbound;
};

export const projectRelay = (
  config: RelaySettingValue,
  ownName: string,
  inbound: InboundRecord
): Option.Option<Inbound> => {
  if (
    ownName !== config.to ||
    !inbound.verified ||
    inbound.from !== config.name
  ) {
    return Option.none();
  }

  return Schema.decodeUnknownOption(RelayRecord)(inbound.record).pipe(
    Option.filter((record) => record.kind !== "data"),
    Option.map((record) => ({
      ...relayedInbound(record),
      relay: {
        did: inbound.did,
        encrypted: record.encrypted,
        name: config.name,
      },
    }))
  );
};

export const deliverRelay = (
  config: RelaySettingValue,
  ownName: string,
  inbound: InboundRecord,
  ports: {
    readonly remember: (original: Inbound) => Effect.Effect<void>;
    readonly deliver: (
      original: Inbound,
      settled: boolean
    ) => Effect.Effect<void>;
  }
) =>
  Effect.gen(function* deliverToStaff() {
    const original = projectRelay(config, ownName, inbound);

    if (Option.isNone(original)) {
      return false;
    }

    yield* ports.remember(original.value);
    yield* ports.deliver(original.value, false);

    return true;
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
            false
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
