import { Context, Deferred, Effect, Layer, Option, Schema } from "effect";

import { ReplyRef } from "../../mailbox-client/src/payload.ts";
import type { ReplyRefValue } from "../../mailbox-client/src/payload.ts";
import type { PendingAskValue } from "./asks.ts";
import { inboundReply, PassSource, RelaySource } from "./payload.ts";
import type { Inbound } from "./payload.ts";

export interface Reply {
  readonly id: string;
  readonly from: string;
  readonly did: string;
  readonly body: string;
}

export interface Received {
  readonly threadRouter?: NonNullable<Inbound["threadRouter"]>;
  readonly via?: NonNullable<Inbound["via"]>;
  readonly originalId?: string;
  readonly relay?: NonNullable<Inbound["relay"]>;
  readonly id: string;
  readonly from: string;
  readonly did: string;
  readonly ask: boolean;
  readonly answered: boolean;
  readonly outbound?: PendingAskValue;
  readonly preview: string;
  readonly reply?: ReplyRefValue;
  readonly ccNames?: readonly string[];
  readonly to?: string;
  readonly thread?: string;
}

export const ThreadJournal = Schema.Array(
  Schema.Struct({
    answered: Schema.Boolean,
    ask: Schema.Boolean,
    ccNames: Schema.optionalKey(Schema.Array(Schema.String)),
    did: Schema.String,
    from: Schema.String,
    id: Schema.String,
    originalId: Schema.optionalKey(Schema.String),
    preview: Schema.String,
    relay: Schema.optionalKey(RelaySource),
    reply: Schema.optionalKey(ReplyRef),
    thread: Schema.optionalKey(Schema.String),
    threadRouter: Schema.optionalKey(RelaySource),
    to: Schema.optionalKey(Schema.String),
    via: Schema.optionalKey(PassSource),
  })
);

export interface ThreadsApi {
  readonly snapshot: Effect.Effect<typeof ThreadJournal.Type>;
  readonly restore: (entries: typeof ThreadJournal.Type) => Effect.Effect<void>;
  readonly wait: (
    id: string,
    did: string
  ) => Effect.Effect<Deferred.Deferred<Reply>>;
  readonly forget: (id: string) => Effect.Effect<void>;
  readonly settle: (inbound: Inbound) => Effect.Effect<boolean>;
  readonly remember: (inbound: Inbound) => Effect.Effect<void>;
  readonly lookup: (id: string) => Effect.Effect<Option.Option<Received>>;
  readonly answer: (id: string) => Effect.Effect<void>;
  readonly pending: Effect.Effect<readonly Received[]>;
}

export const replyRecipients = (
  record: Received,
  self: string,
  replyAll = true
) =>
  [
    ...new Set(
      replyAll
        ? [
            record.from,
            ...(record.to === undefined ? [] : [record.to]),
            ...(record.ccNames ?? []),
          ]
        : [record.from]
    ),
  ].filter((name) => name !== self);

const keep = 200;

export class Threads extends Context.Service<Threads, ThreadsApi>()(
  "pi-ratking/Threads"
) {}

const makeThreads = Effect.sync((): ThreadsApi => {
  const waiters = new Map<
    string,
    { readonly did: string; readonly reply: Deferred.Deferred<Reply> }
  >();

  const received = new Map<string, Received>();

  return {
    answer: (id) =>
      Effect.sync(() => {
        const record = received.get(id);

        if (record !== undefined) {
          received.set(id, { ...record, answered: true });
        }
      }),
    forget: (id) =>
      Effect.sync(() => {
        waiters.delete(id);
      }),
    lookup: (id) =>
      Effect.sync(() =>
        Option.fromNullishOr(
          received.get(id) ??
            [...received.values()].find((record) => record.originalId === id)
        )
      ),
    pending: Effect.sync(() =>
      [...received.values()].filter((record) => record.ask && !record.answered)
    ),
    remember: (inbound) =>
      Effect.sync(() => {
        const record: Received = {
          answered: false,
          ask: inbound.kind === "ask",
          did: inbound.did,
          from: inbound.from,
          id: inbound.id,
          preview: inbound.body.replaceAll(/\s+/gu, " ").slice(0, 80),
        };

        if (inbound.via !== undefined) {
          Object.assign(record, { via: inbound.via });
        }

        if (inbound.originalId !== undefined) {
          Object.assign(record, { originalId: inbound.originalId });
        }

        if (inbound.ccNames !== undefined) {
          Object.assign(record, { ccNames: inbound.ccNames });
        }

        if (inbound.to !== undefined) {
          Object.assign(record, { to: inbound.to });
        }

        const reply = inboundReply(inbound);

        if (Option.isSome(reply)) {
          Object.assign(record, {
            reply: reply.value,
            thread: reply.value.root,
          });
        } else if (inbound.thread !== undefined) {
          Object.assign(record, { thread: inbound.thread });
        }

        if (inbound.threadRouter !== undefined) {
          Object.assign(record, { threadRouter: inbound.threadRouter });
        }

        if (inbound.relay !== undefined) {
          Object.assign(record, { relay: inbound.relay });
        }

        received.set(inbound.id, {
          ...record,
          answered: received.get(inbound.id)?.answered ?? false,
        });

        const closed = [...received.values()].filter(
          (entry) => !entry.ask || entry.answered
        );

        for (const entry of closed.slice(0, -keep)) {
          received.delete(entry.id);
        }
      }),
    restore: (entries) =>
      Effect.sync(() => {
        received.clear();

        for (const entry of entries) {
          received.set(entry.id, entry);
        }
      }),
    settle: (inbound) =>
      Effect.gen(function* settleReply() {
        const parent = Option.map(
          inboundReply(inbound),
          (reply) => reply.parent
        );

        const waiter = Option.flatMapNullishOr(parent, (id) => waiters.get(id));

        if (Option.isNone(waiter) || waiter.value.did !== inbound.did) {
          return false;
        }

        yield* Option.match(parent, {
          onNone: () => Effect.void,
          onSome: (id) => Effect.sync(() => waiters.delete(id)),
        });

        return yield* Deferred.succeed(waiter.value.reply, {
          body: inbound.body,
          did: inbound.did,
          from: inbound.from,
          id: inbound.id,
        });
      }),
    snapshot: Effect.sync(() => [...received.values()]),
    wait: (id, did) =>
      Effect.gen(function* register() {
        const reply = yield* Deferred.make<Reply>();

        waiters.set(id, { did, reply });

        return reply;
      }),
  };
});

export const threadsLayer = Layer.effect(Threads, makeThreads);
