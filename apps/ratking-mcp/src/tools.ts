/* oxlint-disable rat-stack-boundaries/no-hand-rolled-surface -- MCP projects the existing RatKing/Inbox client contracts; no defineContract/toToolkit package exists in this repository. */
import { sendingOptions } from "@rat-king/ratking-client/compose";
import { Directory } from "@rat-king/ratking-client/directory";
import { Inbox, NotDelivered, RatKing } from "@rat-king/ratking-client/ratking";
import type {
  AskOptions,
  Delivered,
  Peeked,
  SendOptions,
} from "@rat-king/ratking-client/ratking";
import { withSummaryLead } from "@rat-king/ratking-client/summary";
import { Effect, Layer, Option, Predicate, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

const Text = Schema.NonEmptyString;

const sending = {
  cc: Schema.optionalKey(Schema.Array(Text)),
  message: Schema.String,
  quiet: Schema.optionalKey(Schema.Boolean),
  summary: Text,
  to: Text,
};

export const tools = Toolkit.make(
  Tool.make("whoami", {
    description:
      "Return this bot's name and public DID. Never provisions a missing key.",
    parameters: Tool.EmptyParams,
    success: Schema.Json,
  }),
  Tool.make("send", {
    description:
      "Send signed plaintext mail. quiet defers the recipient wake; cc gets a quiet copy.",
    parameters: Schema.Struct(sending),
    success: Schema.Json,
  }),
  Tool.make("ask", {
    description:
      "Ask asynchronously. Returns immediately; the reply arrives as mail. quiet asks are refused.",
    parameters: Schema.Struct({
      ...sending,
      dueBy: Schema.optionalKey(Schema.Int),
    }),
    success: Schema.Json,
  }),
  Tool.make("reply", {
    description:
      "Reply by full message id, to all thread participants by default.",
    parameters: Schema.Struct({
      message: Schema.String,
      quiet: Schema.optionalKey(Schema.Boolean),
      replyAll: Schema.optionalKey(Schema.Boolean),
      replyTo: Text,
      summary: Text,
      to: Schema.optionalKey(Text),
    }),
    success: Schema.Json,
  }),
  Tool.make("inbox", {
    description:
      "Peek at unsettled mail without taking a lease or acknowledging. Continue with after=throughSeq.",
    parameters: Schema.Struct({
      after: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
      ),
    }),
    success: Schema.Json,
  }),
  Tool.make("read", {
    description:
      "Read one full message id from mailbox history. Does not acknowledge it.",
    parameters: Schema.Struct({ id: Text }),
    success: Schema.Json,
  }),
  Tool.make("ack", {
    description:
      "Acknowledge exactly these handled ids. Takes and releases a short lease; refuses LeaseHeld. Other backlog may be marked delivered, never acked.",
    parameters: Schema.Struct({ ids: Schema.NonEmptyArray(Text) }),
    success: Schema.Json,
  }),
  Tool.make("pending", {
    description: "List unanswered inbound asks and open outbound asks.",
    parameters: Tool.EmptyParams,
    success: Schema.Json,
  }),
  Tool.make("lookup", {
    description:
      "Look up one name in the configured directory. Never dumps the directory or mints an identity.",
    parameters: Schema.Struct({ name: Text }),
    success: Schema.Json,
  })
);

const entry = (item: Peeked) => {
  const { received } = item;

  const common = {
    did: received.did,
    encrypted: item.encrypted,
    from: received.from,
    id: received.id,
    redelivered: item.redelivered,
    seq: item.seq,
    state: item.state,
    verified: received.verified,
  };

  return "record" in received
    ? { ...common, kind: "record", recordJson: JSON.stringify(received.record) }
    : {
        ...common,
        body: received.body,
        cc: received.ccNames ?? [],
        kind: received.kind,
        replyTo: Option.getOrNull(received.replyTo),
        summary: Option.getOrNull(received.summary),
        thread: received.reply?.root ?? received.thread ?? received.id,
        to: received.to ?? null,
      };
};

const delivery = (sent: Delivered) => ({
  delegatedTo: sent.delegated?.to ?? null,
  did: sent.did,
  id: sent.id,
  presence: sent.presence ?? null,
  recipients: sent.recipients?.map((recipient) => ({ ...recipient })) ?? [],
  seq: sent.seq,
  to: sent.to,
});

interface Fault {
  readonly _tag: string;
  readonly code?: string;
  readonly reason?: string;
  readonly why?: string;
  readonly holder?: string;
  readonly expiresAt?: string;
}

export const refusal = (fault: Fault) => {
  const { holder, expiresAt } = fault;

  return {
    failed: fault.code ?? fault._tag,
    next: Predicate.isTagged(fault, "LeaseHeld")
      ? "Use inbox to peek; retry ack after the current reader releases its lease."
      : "Fix the reason, then use whoami, lookup, pending or inbox before retrying. Do not blindly resend uncertain mail.",
    why: Predicate.isTagged(fault, "LeaseHeld")
      ? `Reader ${holder ?? "unknown"} holds this name until ${expiresAt ?? "unknown"}; nothing was taken.`
      : (fault.reason ?? fault.why ?? "The client refused this operation."),
  };
};

const report = <A extends Schema.Json, E extends Fault, R>(
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.match({ onFailure: refusal, onSuccess: (result) => result })
  );

const optionsFor = (args: {
  readonly summary: string;
  readonly quiet?: boolean;
}) =>
  sendingOptions({
    encrypt: false,
    quiet: args.quiet === true ? true : undefined,
    summary: args.summary,
  });

const makeHandlers = Effect.fn("RatkingMcp.makeHandlers")(
  function* makeHandlers(name: string) {
    const inbox = yield* Inbox;
    const ratking = yield* RatKing;
    const directory = yield* Directory;
    const attached = yield* Effect.cached(inbox.attach(name));

    const named = <A extends Schema.Json, E extends Fault, R>(
      effect: Effect.Effect<A, E, R>
    ) => report(Effect.andThen(attached, effect));

    const pages = Effect.gen(function* pages() {
      const found: { afterSeq: number; messages: readonly Peeked[] }[] = [];

      let afterSeq = 0;

      while (true) {
        const page = yield* inbox.peek({ afterSeq, all: true });
        found.push({ afterSeq, messages: page.messages });

        if (page.hasMore !== true) {
          return found;
        }

        if (page.throughSeq <= afterSeq) {
          return yield* new NotDelivered({
            code: "NotAttempted",
            reason:
              "Mailbox cursor did not advance. Retry inbox; no acknowledgement was attempted.",
          });
        }

        afterSeq = page.throughSeq;
      }
    });

    return tools.of({
      ack: ({ ids }) =>
        named(
          Effect.gen(function* acknowledge() {
            const requested = new Set(ids);
            const history = yield* pages;

            const available = new Set(
              history.flatMap((page) =>
                page.messages
                  .filter(
                    (item) =>
                      item.state === "accepted" || item.state === "delivered"
                  )
                  .map((item) => item.received.id)
              )
            );

            if (ids.some((id) => !available.has(id))) {
              return yield* new NotDelivered({
                code: "NotAttempted",
                reason:
                  "Some ids are not unsettled mail. Use inbox with its cursor; nothing was acknowledged.",
              });
            }

            const acked: string[] = [];

            for (const page of history) {
              if (
                !page.messages.some((item) => requested.has(item.received.id))
              ) {
                continue;
              }

              yield* inbox.hold(
                (item, ack) =>
                  requested.has(item.received.id)
                    ? Effect.andThen(
                        ack,
                        Effect.sync(() => {
                          acked.push(item.received.id);
                        })
                      )
                    : Effect.void,
                { afterSeq: page.afterSeq, session: `mcp-${process.pid}` }
              );
            }

            return { acked };
          })
        ),
      ask: (args) =>
        named(
          Effect.gen(function* ask() {
            const { clamp, options } = optionsFor(args);

            const askingOptions: AskOptions = { ...options };

            if (args.cc !== undefined) {
              Object.assign(askingOptions, { cc: args.cc });
            }

            if (args.dueBy !== undefined) {
              Object.assign(askingOptions, { dueBy: args.dueBy });
            }

            const asking = yield* ratking.ask(
              args.to,
              withSummaryLead(clamp?.full, args.message) ?? "",
              "10 minutes",
              askingOptions
            );

            return { delivered: delivery(asking.delivered) };
          })
        ),
      inbox: ({ after }) =>
        named(
          inbox.peek(after === undefined ? {} : { afterSeq: after }).pipe(
            Effect.map((peek) => ({
              hasMore: peek.hasMore === true,
              messages: peek.messages.map(entry),
              throughSeq: peek.throughSeq,
              unreadable: peek.unreadable.map((item) => ({ ...item })),
            }))
          )
        ),
      lookup: ({ name: requested }) =>
        named(
          directory.resolve(requested).pipe(
            Effect.map((found) => ({
              did: found.did,
              exists: true,
              name: found.name,
            })),
            Effect.catchTag("UnknownName", () =>
              Effect.succeed({ exists: false, name: requested })
            )
          )
        ),
      pending: () =>
        named(
          ratking.pending.pipe(
            Effect.map((pending) => ({
              pending: pending.map((item) => ({ ...item })),
            }))
          )
        ),
      read: ({ id }) =>
        named(
          pages.pipe(
            Effect.map((history) => {
              const found = history
                .flatMap((page) => page.messages)
                .find((item) => item.received.id === id);

              return found === undefined
                ? {
                    failed: "NoSuchMessage",
                    next: "Use inbox and its after cursor to find a full id.",
                    why: "No such message in mailbox history.",
                  }
                : { message: entry(found) };
            })
          )
        ),
      reply: (args) =>
        named(
          Effect.gen(function* reply() {
            const history = yield* pages;

            if (
              !history.some((page) =>
                page.messages.some((item) => item.received.id === args.replyTo)
              )
            ) {
              return {
                failed: "NoSuchMessage",
                next: "Use inbox to find a full id.",
                why: "Reply target is not in mailbox history.",
              };
            }

            const { clamp, options } = optionsFor(args);

            const replyOptions: NonNullable<
              Parameters<typeof ratking.reply>[2]
            > = { ...options };

            if (args.replyAll !== undefined) {
              Object.assign(replyOptions, { replyAll: args.replyAll });
            }

            if (args.to !== undefined) {
              Object.assign(replyOptions, { to: args.to });
            }

            const delivered = yield* ratking.reply(
              args.replyTo,
              withSummaryLead(clamp?.full, args.message) ?? "",
              replyOptions
            );

            return { delivered: delivery(delivered) };
          })
        ),
      send: (args) =>
        named(
          Effect.gen(function* send() {
            const { clamp, options } = optionsFor(args);

            const sendOptions: SendOptions = { ...options };

            if (args.cc !== undefined) {
              Object.assign(sendOptions, { cc: args.cc });
            }

            const delivered = yield* ratking.send(
              args.to,
              withSummaryLead(clamp?.full, args.message) ?? "",
              sendOptions
            );

            return { delivered: delivery(delivered) };
          })
        ),
      whoami: () =>
        report(
          attached.pipe(Effect.map((me) => ({ did: me.did, name: me.name })))
        ),
    });
  }
);

export const registration = (name: string) =>
  McpServer.toolkit(tools).pipe(
    Layer.provide(tools.toLayer(makeHandlers(name)))
  );
