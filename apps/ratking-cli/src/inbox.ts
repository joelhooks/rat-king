import { AskFailed, Inbox } from "@rat-king/ratking-client/ratking";
import type { Peeked } from "@rat-king/ratking-client/ratking";
import { Console, Effect, Option, Result, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { entryDocument, threadOf } from "./entries.ts";
import { withField } from "./output.ts";
import type { Report } from "./output.ts";
import { inboxLine, oneLine, readLines, short } from "./render.ts";
import { sentBy } from "./sent.ts";
import { commonFlags, named, toggle } from "./session.ts";

const notFound = (id: string) =>
  new AskFailed({
    code: "NoSuchMessage",
    reason: `No message ${id} in this mailbox`,
  });

const ambiguous = (id: string, ids: readonly string[]) =>
  new AskFailed({
    code: "AmbiguousId",
    reason: `${id} matches ${ids.length} messages: ${ids.map(short).join(", ")}. Use more characters`,
  });

export const matching = (entries: readonly Peeked[], id: string) => {
  const exact = entries.filter((entry) => entry.received.id === id);

  return exact.length > 0
    ? exact
    : entries.filter((entry) => entry.received.id.startsWith(id));
};

export const locate = Effect.fn("RatkingCli.locate")(function* locate(
  id: string
) {
  const inbox = yield* Inbox;
  const recent = yield* inbox.peek();
  const hits = matching(recent.messages, id);

  const history =
    hits.length > 0
      ? recent.messages
      : (yield* inbox.peek({ all: true })).messages;

  const found = hits.length > 0 ? hits : matching(history, id);

  const [entry] = found;

  if (entry === undefined) {
    return yield* notFound(id);
  }

  if (found.length > 1) {
    return yield* ambiguous(
      id,
      found.map((candidate) => candidate.received.id)
    );
  }

  return { entry, history };
});

export const inboxCommand = Command.make(
  "inbox",
  {
    ...commonFlags,
    after: Flag.Int("after").pipe(Flag.optional),
    all: toggle("all"),
    hold: toggle("hold"),
  },
  (args) =>
    named("inbox", args, (me) =>
      Effect.gen(function* listInbox() {
        const inbox = yield* Inbox;

        if (args.hold) {
          const held: Peeked[] = [];

          yield* inbox.hold(
            (entry, ack) =>
              Effect.gen(function* shown() {
                held.push(entry);

                if (!args.json) {
                  yield* Console.log(inboxLine(entry));
                }

                yield* ack;
              }),
            withField(
              { session: `cli-${process.pid}` },
              "afterSeq",
              Option.getOrUndefined(args.after)
            )
          );

          return {
            document: { held: held.map(entryDocument), name: me.name },
            lines: [`🐀 held ${me.name} · ${held.length} delivered and acked`],
          } satisfies Report;
        }

        const peeked = yield* inbox.peek(
          withField(
            { all: args.all },
            "afterSeq",
            Option.getOrUndefined(args.after)
          )
        );

        return {
          document: {
            hasMore: peeked.hasMore === true,
            messages: peeked.messages.map(entryDocument),
            name: me.name,
            throughSeq: peeked.throughSeq,
            unreadable: peeked.unreadable,
          },
          lines: [
            `🐀 inbox ${me.name} · ${peeked.messages.length} ${args.all ? "messages" : "unread"}${peeked.unreadable.length === 0 ? "" : ` · ${peeked.unreadable.length} unreadable`}`,
            ...peeked.messages.map(inboxLine),
            ...(peeked.hasMore === true
              ? [
                  `More events remain; continue with --after ${peeked.throughSeq}`,
                ]
              : []),
          ],
        } satisfies Report;
      })
    )
).pipe(
  Command.withDescription(
    "List unsettled mail. Peeks and never acks while another reader holds the lease; --hold alone takes the lease, delivers, acks, and refuses LeaseHeld if a live holder exists."
  )
);

export const readCommand = Command.make(
  "read",
  { ...commonFlags, id: Argument.String("id") },
  (args) =>
    named("read", args, () =>
      Effect.gen(function* read() {
        const inbox = yield* Inbox;
        const local = yield* inbox.readReceived(args.id).pipe(Effect.result);

        const warning = Result.isFailure(local)
          ? local.failure.reason
          : undefined;

        const saved = Result.isSuccess(local) ? local.success : Option.none();

        const entry = Option.isSome(saved)
          ? { ...saved.value, state: "acked" }
          : (yield* locate(args.id).pipe(
              Effect.mapError((error) =>
                !Schema.is(AskFailed)(error) || error.code !== "NoSuchMessage"
                  ? error
                  : new AskFailed({
                      code: error.code,
                      reason: `${error.reason}; ${warning ?? "if shown earlier, it may have expired from the local journal"}`,
                    })
              )
            )).entry;

        return {
          document: withField(
            { message: entryDocument(entry) },
            "warning",
            warning
          ),
          lines:
            warning === undefined
              ? readLines(entry)
              : [warning, ...readLines(entry)],
        } satisfies Report;
      })
    )
).pipe(
  Command.withDescription(
    "Show one message in full by id or id prefix. Peeks; acks nothing."
  )
);

export const threadCommand = Command.make(
  "thread",
  { ...commonFlags, id: Argument.String("id") },
  (args) =>
    named("thread", args, (me) =>
      Effect.gen(function* thread() {
        const { entry, history } = yield* locate(args.id);
        const root = threadOf(entry.received);

        const members = history.filter(
          (candidate) => threadOf(candidate.received) === root
        );

        const mine = (yield* sentBy(me.name)).filter(
          (record) => record.thread === root
        );

        const ordered = [
          ...members.map((member) => ({
            document: entryDocument(member),
            id: member.received.id,
            lines: readLines(member),
          })),
          ...mine.map((record) => ({
            document: { ...record, direction: "sent" },
            id: record.id,
            lines: [
              `🐀 sent ${record.to} · ${short(record.id)} · ${oneLine(record.summary, 72)}`,
              "",
              record.body,
            ],
          })),
        ].toSorted((left, right) => left.id.localeCompare(right.id));

        return {
          document: {
            messages: ordered.map((item) => item.document),
            thread: root,
          },
          lines: [
            `🐀 thread ${short(root)} · ${ordered.length} messages`,
            ...ordered.flatMap((item) => ["", ...item.lines]),
          ],
        } satisfies Report;
      })
    )
).pipe(
  Command.withDescription(
    "Show every message on the thread of an id, oldest first. Peeks; acks nothing."
  )
);
