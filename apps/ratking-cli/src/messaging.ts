import {
  InvalidRecord,
  recordSummary,
  validateRecord,
} from "@rat-king/ratking-client/agentgraph";
import { sendingOptions } from "@rat-king/ratking-client/compose";
import type {
  AskOptions,
  Delivered,
  SendOptions,
} from "@rat-king/ratking-client/ratking";
import { Inbox, RatKing } from "@rat-king/ratking-client/ratking";
import { withSummaryLead } from "@rat-king/ratking-client/summary";
import { Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { threadOf } from "./entries.ts";
import { Usage } from "./faults.ts";
import { locate } from "./inbox.ts";
import { withField } from "./output.ts";
import type { Report } from "./output.ts";
import { pendingLines, recipientsOf, sentLine, short } from "./render.ts";
import { recordSent } from "./sent.ts";
import { commonFlags, named, toggle } from "./session.ts";

const ASK_WINDOW = "10 minutes";

const usage = (reason: string, fix: string) =>
  new Usage({
    accepted: "exactly one of --body or --record with --type",
    fix,
    reason,
  });

const readBody = Effect.fn("RatkingCli.readBody")(function* readBody(
  body: string
) {
  if (body !== "-") {
    return body;
  }

  return yield* Stdio.Stdio.use((stdio) =>
    stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)
  ).pipe(
    Effect.mapError(() =>
      usage(
        "Could not read the body from stdin",
        'echo "text" | ratking send --to <name> --body -'
      )
    )
  );
});

const deliveredDocument = (delivered: Delivered) =>
  withField(
    withField(
      {
        id: delivered.id,
        recipients: recipientsOf(delivered),
        seq: delivered.seq,
        to: delivered.to,
      },
      "presence",
      delivered.presence
    ),
    "resolvedTo",
    delivered.resolvedTo
  );

const presenceLines = (delivered: Delivered) =>
  delivered.presence === undefined ? [] : [delivered.presence];

const messageText = Effect.fn("RatkingCli.messageText")(function* messageText(
  body: Option.Option<string>,
  lead: string | undefined
) {
  if (Option.isNone(body)) {
    return yield* usage(
      "Missing --body",
      'ratking send --to <name> --summary "..." --body "..."'
    );
  }

  return withSummaryLead(lead, yield* readBody(body.value)) ?? "";
});

export const sendCommand = Command.make(
  "send",
  {
    ...commonFlags,
    body: Flag.String("body").pipe(Flag.optional),
    cc: Flag.String("cc").pipe(Flag.atLeast(0)),
    ccOnPurpose: toggle("cc-on-purpose"),
    encrypt: toggle("encrypt"),
    quiet: toggle("quiet"),
    record: Flag.String("record").pipe(Flag.optional),
    summary: Flag.String("summary").pipe(Flag.optional),
    to: Flag.String("to"),
    type: Flag.String("type").pipe(Flag.optional),
  },
  (args) =>
    named("send", args, (me) =>
      Effect.gen(function* send() {
        const ratking = yield* RatKing;

        const { clamp, options } = sendingOptions({
          ccOnPurpose: args.ccOnPurpose ? true : undefined,
          encrypt: args.encrypt ? true : undefined,
          quiet: args.quiet ? true : undefined,
          summary: Option.getOrUndefined(args.summary),
        });

        const withCc: SendOptions = { ...options, cc: args.cc };

        const recordFile = Option.getOrUndefined(args.record);

        const text =
          recordFile === undefined
            ? yield* messageText(args.body, clamp?.full)
            : "";

        const delivered = yield* recordFile === undefined
          ? ratking.send(args.to.trim(), text, withCc)
          : Effect.gen(function* sendRecord() {
              const fs = yield* FileSystem.FileSystem;

              const raw = yield* fs
                .readFileString(recordFile)
                .pipe(
                  Effect.mapError(() =>
                    usage(
                      "record: supply a readable JSON file",
                      "ratking send --to <name> --record <file.json> --type <nsid>"
                    )
                  )
                );

              const json = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Json)
              )(raw).pipe(
                Effect.mapError(
                  () =>
                    new InvalidRecord({ reason: "record: supply valid JSON" })
                )
              );

              const value = yield* validateRecord(
                Option.getOrUndefined(args.type),
                json
              );

              return yield* ratking.send(
                args.to.trim(),
                JSON.stringify(value),
                {
                  ...withCc,
                  kind: "data",
                  summary: Option.getOrElse(args.summary, () =>
                    recordSummary(value)
                  ),
                }
              );
            });

        yield* recordSent({
          body: text,
          from: me.name,
          id: delivered.id,
          seq: delivered.seq,
          summary: Option.getOrElse(args.summary, () => text),
          thread: delivered.id,
          to: delivered.to,
        });

        return {
          document: withField(
            { delivered: deliveredDocument(delivered) },
            "note",
            clamp?.note
          ),
          lines: [
            sentLine("sent", delivered),
            ...presenceLines(delivered),
            ...(clamp === undefined ? [] : [clamp.note]),
          ],
        } satisfies Report;
      })
    )
).pipe(
  Command.withDescription(
    "Send a message or an agent-graph record. Signs with the name's key; never takes the lease."
  )
);

export const askCommand = Command.make(
  "ask",
  {
    ...commonFlags,
    body: Flag.String("body").pipe(Flag.optional),
    cc: Flag.String("cc").pipe(Flag.atLeast(0)),
    ccOnPurpose: toggle("cc-on-purpose"),
    dueBy: Flag.Int("due-by").pipe(Flag.optional),
    encrypt: toggle("encrypt"),
    quiet: toggle("quiet"),
    summary: Flag.String("summary").pipe(Flag.optional),
    timeout: Flag.Int("timeout").pipe(Flag.withDefault(600)),
    to: Flag.String("to"),
    wait: toggle("wait"),
  },
  (args) =>
    named(
      "ask",
      args,
      (me) =>
        Effect.gen(function* ask() {
          const ratking = yield* RatKing;

          const { clamp, options } = sendingOptions({
            ccOnPurpose: args.ccOnPurpose ? true : undefined,
            encrypt: args.encrypt ? true : undefined,
            quiet: args.quiet ? true : undefined,
            summary: Option.getOrUndefined(args.summary),
          });

          const message = yield* messageText(args.body, clamp?.full);
          const asking: AskOptions = { ...options, cc: args.cc };

          if (Option.isSome(args.dueBy)) {
            Object.assign(asking, { dueBy: args.dueBy.value });
          }

          if (args.wait) {
            Object.assign(asking, { wait: true });
          }

          const { delivered, reply } = yield* ratking.ask(
            args.to.trim(),
            message,
            args.wait ? `${args.timeout} seconds` : ASK_WINDOW,
            asking
          );

          yield* recordSent({
            body: message,
            from: me.name,
            id: delivered.id,
            seq: delivered.seq,
            summary: Option.getOrElse(args.summary, () => message),
            thread: delivered.id,
            to: delivered.to,
          });

          return {
            document: withField(
              { delivered: deliveredDocument(delivered) },
              "reply",
              reply === undefined
                ? undefined
                : { body: reply.body, from: reply.from, id: reply.id }
            ),
            lines:
              reply === undefined
                ? [
                    sentLine("asked", delivered),
                    ...presenceLines(delivered),
                    "The reply arrives as a message: ratking inbox",
                  ]
                : [
                    sentLine("asked", delivered),
                    `🐀 reply from ${reply.from} · ${short(reply.id)}`,
                    "",
                    reply.body,
                  ],
          } satisfies Report;
        }),
      args.wait
        ? Math.min(600_000, Math.max(1, args.timeout * 1000))
        : undefined
    )
).pipe(
  Command.withDescription(
    "Ask and return at once; the reply arrives as mail. --wait blocks for it. Never takes the lease."
  )
);

export const replyCommand = Command.make(
  "reply",
  {
    ...commonFlags,
    body: Flag.String("body").pipe(Flag.optional),
    ccOnPurpose: toggle("cc-on-purpose"),
    encrypt: toggle("encrypt"),
    id: Argument.String("id"),
    onlySender: toggle("only-sender"),
    quiet: toggle("quiet"),
    summary: Flag.String("summary").pipe(Flag.optional),
    to: Flag.String("to").pipe(Flag.optional),
  },
  (args) =>
    named("reply", args, (me) =>
      Effect.gen(function* reply() {
        const ratking = yield* RatKing;

        const { clamp, options } = sendingOptions({
          ccOnPurpose: args.ccOnPurpose ? true : undefined,
          encrypt: args.encrypt ? true : undefined,
          quiet: args.quiet ? true : undefined,
          summary: Option.getOrUndefined(args.summary),
        });

        const message = yield* messageText(args.body, clamp?.full);

        const { entry } = yield* locate(args.id);
        const parent = entry.received.id;

        const delivered = yield* ratking.reply(parent, message, {
          ...options,
          replyAll: !args.onlySender,
          to: Option.getOrUndefined(args.to),
        });

        yield* recordSent({
          body: message,
          from: me.name,
          id: delivered.id,
          replyTo: parent,
          seq: delivered.seq,
          summary: Option.getOrElse(args.summary, () => message),
          thread: threadOf(entry.received),
          to: delivered.to,
        });

        return {
          document: {
            delivered: deliveredDocument(delivered),
            replyTo: parent,
          },
          lines: [
            `${sentLine("replied", delivered)} · to ${short(parent)}`,
            ...presenceLines(delivered),
          ],
        } satisfies Report;
      })
    )
).pipe(
  Command.withDescription(
    "Reply to a message by id, to everyone on its thread unless --only-sender. Never takes the lease."
  )
);

export const pendingCommand = Command.make("pending", commonFlags, (args) =>
  named("pending", args, () =>
    Effect.gen(function* pending() {
      const inbox = yield* Inbox;
      const ratking = yield* RatKing;

      yield* inbox.peek();

      const asks = yield* ratking.pending;

      return {
        document: {
          asks: asks.map((ask) => ({
            id: ask.id,
            outbound: ask.outbound !== undefined,
            party: ask.outbound === undefined ? ask.from : ask.outbound.to,
            preview: ask.preview,
          })),
        },
        lines: pendingLines(asks),
      } satisfies Report;
    })
  )
).pipe(
  Command.withDescription(
    "List unanswered inbound asks and open outbound asks. Peeks; acks nothing."
  )
);
