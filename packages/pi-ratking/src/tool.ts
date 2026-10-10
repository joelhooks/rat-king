import { Effect, Match, Option, Schema } from "effect";
import type { Duration } from "effect";

import type { NotConfigured } from "./config.ts";
import { RatKing, ReaderState } from "./ratking.ts";
import type { NotDelivered, Status } from "./ratking.ts";

export const Action = Schema.Literals([
  "list",
  "list-cwd",
  "send",
  "ask",
  "handover",
  "reply",
  "pending",
  "status",
  "cancel",
]);

export const Attachment = Schema.Struct({
  content: Schema.String,
  language: Schema.optionalKey(Schema.String),
  name: Schema.String,
  type: Schema.Literals(["file", "snippet", "context"]),
});

export const ToolParams = Schema.Struct({
  action: Action,
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  cwd: Schema.optionalKey(Schema.String),
  focus: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(Schema.String),
  messageId: Schema.optionalKey(Schema.String),
  openProjectPaneIfMissing: Schema.optionalKey(Schema.Boolean),
  replyTo: Schema.optionalKey(Schema.String),
  retryOf: Schema.optionalKey(Schema.String),
  supersedes: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
});

export type ToolParamsValue = typeof ToolParams.Type;

export interface ToolText {
  readonly text: string;
  readonly isError: boolean;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

const ok = (text: string, details: ToolText["details"] = {}): ToolText => ({
  details,
  isError: false,
  text,
});

const loud = (text: string, details: ToolText["details"] = {}): ToolText => ({
  details: { error: true, ...details },
  isError: true,
  text,
});

export const notDeliveredText = (error: NotDelivered) =>
  `NOT DELIVERED: ${error.code}. ${error.reason}. No intercom fallback; nothing reached the recipient.`;

export const description = (tool: string) =>
  `Rat King messaging: signed, end-to-end encrypted mail between named agents on any machine. Every message goes to a name's durable mailbox; whoever holds that name's lease reads it. A failed send is an error, never a silent fallback.

Address agents by Rat King name (for example switchboard, or project/row).

Usage:
  ${tool}({ action: "send", to: "name", message: "..." })            → Deliver a message
  ${tool}({ action: "ask", to: "name", message: "..." })             → Ask and wait for the threaded reply
  ${tool}({ action: "reply", replyTo: "<id>", message: "..." })      → Answer a message by its id
  ${tool}({ action: "pending" })                                     → Unanswered inbound asks
  ${tool}({ action: "list" })                                        → The Rat King directory
  ${tool}({ action: "status" })                                      → This Pi's name and reader`;

export const promptSnippet = (tool: string) =>
  `Message other agents over Rat King with ${tool}: send, ask and wait, reply by id, list the directory.`;

export const statusText = (tool: string, status: Status) => {
  const self = Option.match(status.self, {
    onNone: () => "no identity yet",
    onSome: ({ did, name }) => `${name} (${did})`,
  });

  const reader = ReaderState.$match(status.reader, {
    Acquiring: () => "acquiring lease",
    Live: ({ expiresAt, generation }) =>
      `live, lease generation ${generation} until ${expiresAt}`,
    Minting: ({ name }) => `minting ${name}`,
    Retrying: ({ attempt, reason }) =>
      `retrying (attempt ${attempt}): ${reason}`,
    Starting: () => "starting",
  });

  return `Rat King (${tool}): ${self} · reader ${reader} · mailbox ${status.endpoint}`;
};

const withAttachments = (params: ToolParamsValue) =>
  Option.map(Option.fromNullishOr(params.message), (message) =>
    params.attachments === undefined || params.attachments.length === 0
      ? message
      : [
          message,
          ...params.attachments.map(
            (item) =>
              `--- ${item.type}: ${item.name}${item.language === undefined ? "" : ` (${item.language})`}\n${item.content}`
          ),
        ].join("\n\n")
  );

const needMessage = (params: ToolParamsValue) =>
  Option.match(withAttachments(params), {
    onNone: () => Effect.fail(loud("Missing 'message' parameter")),
    onSome: Effect.succeed,
  });

const needTo = (params: ToolParamsValue) =>
  params.to === undefined || params.to.trim() === ""
    ? Effect.fail(
        loud(
          params.cwd === undefined
            ? "Missing 'to' parameter"
            : "Rat King addresses agents by name; cwd targeting is not supported. Pass 'to'."
        )
      )
    : Effect.succeed(params.to.trim());

export const runAction = Effect.fn("RatKing.runAction")(function* runAction(
  tool: string,
  askTimeout: Duration.Input,
  params: ToolParamsValue
) {
  const ratking = yield* RatKing;

  if (params.openProjectPaneIfMissing === true) {
    return loud(
      "openProjectPaneIfMissing is not available on Rat King; launch the agent first, then send."
    );
  }

  return yield* Match.value(params.action).pipe(
    Match.when("status", () =>
      ratking.status.pipe(Effect.map((status) => ok(statusText(tool, status))))
    ),
    Match.whenOr("list", "list-cwd", () =>
      Effect.gen(function* list() {
        const status = yield* ratking.status;
        const entries = yield* ratking.list;
        const own = status.self.pipe(Option.map(({ name }) => name));

        return ok(
          [
            statusText(tool, status),
            "",
            "**Directory:**",
            ...(entries.length === 0
              ? ["- empty"]
              : entries.map(
                  (entry) =>
                    `- ${entry.name}${entry.aliases.length === 0 ? "" : ` (alias ${entry.aliases.join(", ")})`} · ${entry.did}${entry.reserved ? " · reserved" : ""}${own.pipe(Option.contains(entry.name)) ? " · you" : ""}`
                )),
          ].join("\n")
        );
      })
    ),
    Match.when("cancel", () =>
      Effect.succeed(
        loud(
          "cancel is not possible on Rat King: an accepted message is already in the recipient's mailbox. Send a correction instead."
        )
      )
    ),
    Match.when("handover", () =>
      Effect.succeed(
        loud(
          "handover is not supported by Rat King yet. Summarise the work yourself and use send."
        )
      )
    ),
    Match.when("pending", () =>
      ratking.pending.pipe(
        Effect.map((asks) =>
          asks.length === 0
            ? ok("No unresolved inbound asks.")
            : ok(
                [
                  "**Pending asks:**",
                  ...asks.map(
                    (ask) => `- ${ask.from} · ${ask.id} · ${ask.preview}`
                  ),
                ].join("\n"),
                { pending: asks.length }
              )
        )
      )
    ),
    Match.when("reply", () =>
      Effect.gen(function* reply() {
        const message = yield* needMessage(params);
        const pending = yield* ratking.pending;

        const target =
          params.replyTo ?? (pending.length === 1 ? pending[0]?.id : undefined);

        if (target === undefined) {
          return loud(
            pending.length === 0
              ? "No pending ask to reply to; pass replyTo from the message, or use send."
              : `Several asks are pending; pass replyTo: ${pending.map((ask) => ask.id).join(", ")}`
          );
        }

        const delivered = yield* ratking.reply(target, message);

        return ok(
          `Reply delivered to ${delivered.to} over Rat King (id ${delivered.id}, seq ${delivered.seq}).`,
          { id: delivered.id, replyTo: target, seq: delivered.seq }
        );
      })
    ),
    Match.when("send", () =>
      Effect.gen(function* send() {
        const to = yield* needTo(params);
        const message = yield* needMessage(params);
        const delivered = yield* ratking.send(to, message);

        return ok(
          `Delivered to ${delivered.to} over Rat King (id ${delivered.id}, seq ${delivered.seq}).`,
          { id: delivered.id, seq: delivered.seq, to: delivered.to }
        );
      })
    ),
    Match.when("ask", () =>
      Effect.gen(function* ask() {
        const to = yield* needTo(params);
        const message = yield* needMessage(params);

        const { delivered, reply } = yield* ratking.ask(
          to,
          message,
          askTimeout
        );

        return ok(
          `**Reply from ${reply.from}** (id ${reply.id}):\n${reply.body}`,
          {
            id: delivered.id,
            replyId: reply.id,
          }
        );
      })
    ),
    Match.exhaustive,
    Effect.catchTags({
      AskFailed: (error) =>
        Effect.succeed(
          loud(`${error.code}: ${error.reason}`, { code: error.code })
        ),
      NotDelivered: (error) =>
        Effect.succeed(loud(notDeliveredText(error), { code: error.code })),
    }),
    Effect.match({ onFailure: (text) => text, onSuccess: (text) => text })
  );
});

export const notConfiguredText = (error: NotConfigured) =>
  loud(`NOT DELIVERED: NotConfigured. ${error.reason}.`, {
    code: "NotConfigured",
  });
