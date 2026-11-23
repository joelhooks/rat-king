import { Effect, Option, Schema, Semaphore } from "effect";
import { createMachine, transition } from "xstate";

import type { RelaySettingValue } from "./config.ts";
import { addressedElsewhere } from "./name.ts";
import { Kind, PassSource } from "./payload.ts";
import type { Inbound, InboundRecord, LexiconRecordValue } from "./payload.ts";

export const RelayRecord = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.relay#message"),
  body: Schema.String,
  cc: Schema.Boolean,
  ccNames: Schema.optionalKey(Schema.Array(Schema.String)),
  copy: Schema.optionalKey(Schema.Boolean),
  did: Schema.String,
  encrypted: Schema.Boolean,
  expiresAt: Schema.optionalKey(Schema.String),
  from: Schema.String,
  id: Schema.String,
  kind: Kind,
  label: Schema.NullOr(Schema.String),
  quiet: Schema.optionalKey(Schema.Literal(true)),
  replyTo: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  thread: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  verified: Schema.Boolean,
  via: Schema.optionalKey(PassSource),
});

export const RelayOutbound = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.relay#outbound"),
  body: Schema.String,
  cc: Schema.Array(Schema.String),
  encrypted: Schema.Boolean,
  id: Schema.String,
  kind: Kind,
  replyTo: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  thread: Schema.String,
  to: Schema.String,
});

export type RelayOutboundValue = typeof RelayOutbound.Type;

export const copiesOutbound = (
  config: RelaySettingValue | undefined,
  ownName: string,
  recipients: readonly string[]
): config is RelaySettingValue =>
  config?.copyOutbound === true &&
  ownName === config.name &&
  !recipients.includes(config.to);

export const RelayHandled = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.relay#handled"),
  id: Schema.String,
});

const passiveFlags = (input: Pick<Inbound, "copy" | "quiet">) => {
  const flags: Pick<typeof RelayRecord.Type, "copy" | "quiet"> = {};

  if (input.copy === true) {
    Object.assign(flags, { copy: true });
  }

  if (input.quiet === true) {
    Object.assign(flags, { quiet: true });
  }

  return flags;
};

export const relayRecord = (
  inbound: Inbound,
  encrypted: boolean
): typeof RelayRecord.Type => {
  const record: typeof RelayRecord.Type = {
    $type: "sh.mschf.ratking.relay#message",
    body: inbound.body,
    cc: (inbound.ccNames?.length ?? 0) > 0,
    ...passiveFlags(inbound),
    copy: inbound.cc,
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

  if (inbound.expiresAt !== undefined) {
    Object.assign(record, { expiresAt: inbound.expiresAt });
  }

  if (inbound.via !== undefined) {
    Object.assign(record, { via: inbound.via });
  }

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
    cc: record.copy === true,
    ...passiveFlags(record),
    did: record.did,
    encrypted: record.encrypted,
    from: record.from,
    id: record.id,
    kind: record.kind,
    label: Option.fromNullishOr(record.label),
    replyTo: Option.fromNullishOr(record.replyTo),
    summary: Option.fromNullishOr(record.summary),
    verified: record.verified,
  };

  if (record.expiresAt !== undefined) {
    Object.assign(inbound, { expiresAt: record.expiresAt });
  }

  if (record.via !== undefined) {
    Object.assign(inbound, { via: record.via });
  }

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

const sentCopy = (
  inbound: InboundRecord,
  record: RelayOutboundValue
): Inbound => ({
  body: record.body,
  cc: false,
  ccNames: record.cc,
  did: inbound.did,
  encrypted: inbound.encrypted !== false || record.encrypted,
  from: inbound.from,
  id: record.id,
  kind: record.kind,
  label: Option.none(),
  replyTo: Option.fromNullishOr(record.replyTo),
  sentBy: inbound.from,
  summary: Option.fromNullishOr(record.summary),
  thread: record.thread,
  to: record.to,
  verified: true,
});

const relayCopy = (
  record: typeof RelayRecord.Type,
  ownName: string,
  desk: string
) => {
  if (record.copy !== undefined) {
    return record.copy;
  }

  if (!record.cc) {
    return false;
  }

  return record.to === undefined
    ? (record.ccNames?.some((name) => name === ownName || name === desk) ??
        false)
    : addressedElsewhere({}, record.to, ownName) &&
        addressedElsewhere({}, record.to, desk);
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

  const sent = Schema.decodeUnknownOption(RelayOutbound)(inbound.record);

  if (Option.isSome(sent)) {
    return Option.some(sentCopy(inbound, sent.value));
  }

  return Schema.decodeUnknownOption(RelayRecord)(inbound.record).pipe(
    Option.filter((record) => record.kind !== "data"),
    Option.map((record) => {
      const copy = relayCopy(record, ownName, config.name);

      return {
        ...relayedInbound(record),
        cc: copy,
        copy,
        encrypted: inbound.encrypted !== false || record.encrypted,
        relay: {
          did: inbound.did,
          encrypted: record.encrypted,
          name: config.name,
        },
        routedCopy: copy,
        routedWake: config.mode === "front" && !copy,
      };
    })
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

    if (original.value.sentBy === undefined) {
      yield* ports.remember(original.value);
    }

    yield* ports.deliver(original.value, false);

    return true;
  });

export const transferCustody = <A, E, R>(
  send: Effect.Effect<A, E, R>,
  recorded: Effect.Effect<void, E, R>,
  ack: Effect.Effect<void>
) => send.pipe(Effect.andThen(recorded), Effect.andThen(ack));

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
  forwarded: Schema.optionalKey(Schema.Boolean),
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
      answered: (names: readonly string[]) =>
        mutex.withPermit(
          Effect.gen(function* answered() {
            for (const entry of entries.values()) {
              if (
                entry.state === "pending" &&
                names.includes(entry.record.from)
              ) {
                yield* finish(entry, "handled");
              }
            }
          })
        ),
      closed: (id: string) =>
        Effect.sync(() => entries.get(id)?.state === "handled"),
      failed: (id: string) =>
        mutex.withPermit(
          Effect.gen(function* failed() {
            const entry = entries.get(id);

            if (entry !== undefined) {
              yield* finish(entry, "fallback");
            }
          })
        ),
      forwarded: (id: string) =>
        mutex.withPermit(
          Effect.gen(function* forwarded() {
            const entry = entries.get(id);

            if (entry !== undefined) {
              yield* saveEntry({ ...entry, forwarded: true });
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
      originals: Effect.sync(() =>
        [...entries.values()].map((entry) => relayedInbound(entry.record))
      ),
      receive: (
        inbound: Inbound,
        settled: boolean,
        encrypted: boolean,
        now: number,
        redelivered = false
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

            const existing = entries.get(inbound.id);

            if (existing !== undefined) {
              if (
                redelivered &&
                existing.state === "injected" &&
                existing.forwarded !== true
              ) {
                yield* ports.inject(
                  {
                    ...inbound,
                    body: `[staff did not handle]\n${inbound.body}`,
                  },
                  false
                );
              }

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
      transferred: (id: string) =>
        Effect.sync(() => entries.get(id)?.forwarded === true),
    };

    yield* relay.recover(yield* ports.now);

    return relay;
  });
