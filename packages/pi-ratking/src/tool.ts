import * as Deadline from "@rat-king/mailbox-client/deadline";
import {
  invalidRecordText,
  recordSummary,
  validateRecord,
} from "@rat-king/ratking-client/agentgraph";
import { askAge } from "@rat-king/ratking-client/asks";
import {
  decimalPreferences,
  FilterInput,
  filterRules,
  filterLines,
} from "@rat-king/ratking-client/attention";
import { ccRefusalPrompt } from "@rat-king/ratking-client/cc-lint";
import { sendingOptions } from "@rat-king/ratking-client/compose";
import type { NotConfigured } from "@rat-king/ratking-client/config";
import { recipientLines } from "@rat-king/ratking-client/delivery";
import type { RecipientLevelValue } from "@rat-king/ratking-client/delivery";
import { listView } from "@rat-king/ratking-client/directory-view";
import type { QuietAsk } from "@rat-king/ratking-client/errors";
import { LexiconRecord } from "@rat-king/ratking-client/payload";
import { literalPrompt } from "@rat-king/ratking-client/prompt";
import {
  RatKing,
  ClaimOutcome,
  ReaderControl,
  ReaderState,
  SendPhase,
} from "@rat-king/ratking-client/ratking";
import type {
  AskOptions,
  Delivered,
  NotDelivered,
  SendOptions,
  Status,
} from "@rat-king/ratking-client/ratking";
import { withSummaryLead } from "@rat-king/ratking-client/summary";
import {
  Clock,
  DateTime,
  Effect,
  Fiber,
  Match,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
import type { Duration } from "effect";
import type { PlatformError } from "effect/PlatformError";

export const Action = Schema.Literals([
  "attention",
  "filter",
  "list",
  "list-cwd",
  "send",
  "record",
  "ask",
  "handover",
  "reply",
  "pending",
  "handled",
  "status",
  "cancel",
  "claim",
  "retire",
]);

export const Attachment = Schema.Struct({
  content: Schema.String,
  language: Schema.optionalKey(Schema.String),
  name: Schema.String,
  type: Schema.Literals(["file", "snippet", "context"]),
});

export const ToolParams = Schema.Struct({
  action: Action,
  all: Schema.optionalKey(Schema.Boolean),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  cc: Schema.optionalKey(Schema.Array(Schema.String)),
  ccOnPurpose: Schema.optionalKey(Schema.Boolean),
  critical: Schema.optionalKey(Schema.Boolean),
  cwd: Schema.optionalKey(Schema.String),
  delegate: Schema.optionalKey(Schema.String),
  dueBy: Schema.optionalKey(Schema.Finite),
  encrypt: Schema.optionalKey(Schema.Boolean),
  exempt: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(16))
  ),
  focus: Schema.optionalKey(Schema.Boolean),
  id: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 }))
  ),
  match: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  messageId: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  op: Schema.optionalKey(FilterInput.fields.op),
  openProjectPaneIfMissing: Schema.optionalKey(Schema.Boolean),
  prefs: Schema.optionalKey(Schema.Json),
  quiet: Schema.optionalKey(Schema.Boolean),
  record: Schema.optionalKey(Schema.Json),
  replyAll: Schema.optionalKey(Schema.Boolean),
  replyTo: Schema.optionalKey(Schema.String),
  retryOf: Schema.optionalKey(Schema.String),
  rule: Schema.optionalKey(Schema.Json),
  status: Schema.optionalKey(Schema.Literals(["available", "busy", "dnd"])),
  successor: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  supersedes: Schema.optionalKey(Schema.String),
  timeoutSeconds: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ maximum: 600, minimum: 1 }))
  ),
  to: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  until: Schema.optionalKey(Schema.String),
  wait: Schema.optionalKey(Schema.Boolean),
});

export type ToolParamsValue = typeof ToolParams.Type;

export const toolCall = (tool: string, params: ToolParamsValue) =>
  `${tool}(${JSON.stringify(
    Schema.encodeSync(ToolParams)(params, { onExcessProperty: "error" })
  )})`;

export type DetailValue =
  | string
  | number
  | boolean
  | readonly RecipientLevelValue[];

export interface ToolText {
  readonly text: string;
  readonly isError: boolean;
  readonly details: Readonly<Record<string, DetailValue>>;
}

export type DispatchPhase = "idle" | "issued" | "delivered";

export type Dispatch = Ref.Ref<DispatchPhase>;

export const idleDispatch = (): Dispatch =>
  Ref.makeUnsafe<DispatchPhase>("idle");

export const cancelledText = (
  params: Pick<ToolProgressParams, "to">,
  phase: DispatchPhase
): ToolText => {
  const party = params.to ?? "the recipient";

  if (phase === "delivered") {
    return {
      details: { cancelled: true, sent: true },
      isError: false,
      text: "ASK SENT; stopped waiting. The reply will arrive as a message.",
    };
  }

  return phase === "issued"
    ? {
        details: { cancelled: true, sent: "uncertain" },
        isError: true,
        text: `CANCELLED: outcome uncertain. The message may have reached ${party}; do not resend. Check with ratking pending or the thread.`,
      }
    : {
        details: { cancelled: true, sent: false },
        isError: true,
        text: `CANCELLED: not sent. Nothing reached ${party}.`,
      };
};

export type PhaseReport = (phase: SendPhase) => Effect.Effect<void>;

const dispatching = <T extends object>(
  options: T,
  dispatch?: Dispatch,
  onPhase?: PhaseReport
): T => {
  if (dispatch !== undefined) {
    Object.assign(options, { onDispatch: Ref.set(dispatch, "issued") });
  }

  if (onPhase !== undefined) {
    Object.assign(options, { onPhase });
  }

  return options;
};

type RatKingService = typeof RatKing.Service;

export const retireOwn = (
  ratking: Pick<RatKingService, "retire">,
  successor: string | undefined
) =>
  ratking.retire(
    Option.fromNullishOr(successor).pipe(
      Option.map((name) => name.trim()),
      Option.filter((name) => name !== "")
    )
  );

const handledIssuing =
  (dispatch: Dispatch, call: RatKingService["handled"]) => (id: string) =>
    Ref.set(dispatch, "issued").pipe(Effect.andThen(call(id)));

const tracked = (
  ratking: RatKingService,
  dispatch: Dispatch | undefined
): RatKingService =>
  dispatch === undefined
    ? ratking
    : { ...ratking, handled: handledIssuing(dispatch, ratking.handled) };

export interface ToolProgressParams {
  readonly action: string;
  readonly to?: string | undefined;
}

export const STARTING_PHASE = "starting Rat King";

export const phaseText = (phase: SendPhase) =>
  SendPhase.$match(phase, {
    AwaitingReply: ({ from }) => `awaiting reply from ${from}`,
    Identity: () => "waiting for identity",
    Reader: () => "waiting for reader",
    Resolving: ({ name }) => `resolving ${name}`,
    Retrying: ({ attempt, reason }) =>
      `retrying (${reason}, attempt ${attempt})`,
    Sealing: () => "sealing",
    Sending: () => "sending",
  });

export const initialPhase = (params: ToolProgressParams) => {
  const to = params.to?.trim() ?? "";

  return Match.value(params.action).pipe(
    Match.whenOr("send", "ask", "record", () =>
      to === "" ? params.action : `resolving ${to}`
    ),
    Match.when("reply", () => "finding the thread"),
    Match.whenOr("list", "list-cwd", () => "reading the directory"),
    Match.when("pending", () => "reading asks"),
    Match.when("status", () => "reading status"),
    Match.orElse((action) => action)
  );
};

export const toolProgress = (phase: string, elapsedMs = 0): ToolText => ({
  details: { elapsedMs, phase },
  isError: false,
  text:
    elapsedMs < 1000 ? phase : `${phase} · ${Math.floor(elapsedMs / 1000)}s`,
});

export type ProgressReport = (phase: string) => Effect.Effect<void>;

export const withToolLiveness = <E, R>(
  initial: string,
  action: (report: ProgressReport) => Effect.Effect<ToolText, E, R>,
  update: (progress: ToolText) => void
): Effect.Effect<ToolText, E, R> =>
  Effect.gen(function* toolLiveness() {
    const started = yield* Clock.currentTimeMillis;
    const shown = yield* Ref.make({ elapsedMs: 0, phase: initial });

    const report: ProgressReport = (phase) =>
      Ref.modify(shown, (current) =>
        current.phase === phase
          ? [Option.none<ToolText>(), current]
          : [
              Option.some(toolProgress(phase, current.elapsedMs)),
              { ...current, phase },
            ]
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (progress) =>
              Effect.sync(() => {
                update(progress);
              }),
          })
        )
      );

    const ticker = yield* Effect.gen(function* toolTick() {
      const now = yield* Clock.currentTimeMillis;

      const current = yield* Ref.updateAndGet(shown, (value) => ({
        ...value,
        elapsedMs: now - started,
      }));

      update(toolProgress(current.phase, current.elapsedMs));
    }).pipe(
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.delay("1 second"),
      Effect.forkChild
    );

    const result = yield* action(report).pipe(
      Effect.ensuring(Fiber.interrupt(ticker))
    );

    const ended = yield* Clock.currentTimeMillis;

    return {
      ...result,
      details: { ...result.details, durationMs: ended - started },
    };
  });

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

const withPresence = (text: string, delivered: Delivered) =>
  delivered.presence === undefined ? text : `${text}\n${delivered.presence}`;

const presenceDetails = (delivered: Delivered) =>
  delivered.presence === undefined ? {} : { presence: delivered.presence };

const recipientsOf = (delivered: Delivered) =>
  delivered.recipients ?? [{ level: "wake" as const, name: delivered.to }];

export const receiptText = (lead: string, delivered: Delivered) => {
  if (delivered.delegated !== undefined) {
    return `Delivered to ${delivered.to}; delegated to ${delivered.delegated.to}${delivered.delegated.until === undefined ? "" : ` until ${delivered.delegated.until}`} (id ${delivered.id}, seq ${delivered.seq}).`;
  }

  return recipientsOf(delivered).length > 1 ||
    recipientsOf(delivered).some((recipient) => recipient.level === "quiet")
    ? [
        `Delivered over Rat King (id ${delivered.id}, seq ${delivered.seq}).`,
        ...recipientLines(recipientsOf(delivered)),
      ].join("\n")
    : `${lead} ${delivered.to} over Rat King (id ${delivered.id}, seq ${delivered.seq}).`;
};

export const notDeliveredText = (error: NotDelivered | QuietAsk) =>
  Match.value(error.code).pipe(
    Match.whenOr("ReaderCannotRender", "AskAimedAtCc", () => error.reason),
    Match.when("Partial", () => `PARTIAL DELIVERY: ${error.reason}`),
    Match.orElse(
      () =>
        `NOT DELIVERED: ${error.code}. ${error.reason}. No fallback; nothing reached the recipient.`
    )
  );

export const description = (tool: string) =>
  `Rat King messaging: signed mail between named agents on any machine. Every message goes to a name's durable mailbox; whoever holds that name's lease reads it. A failed send is an error, never a silent fallback.

Messages are signed plaintext by default, readable by operators and observers such as Joel's phone feed. Pass encrypt: true on send, ask or reply to end-to-end encrypt anything containing secrets, credentials, customer data or private transcripts. With encrypt: true, summary and attachments are sealed with the body; only the sender's local sent record stays readable.

Address agents by Rat King name (for example switchboard, or project/row). list shows at most 50 names, hides session/probe/canary names, and stays under 4 KB. match filters names (a trailing / means prefix); all includes ephemeral names and DIDs. Page with limit (1–200, default 50) and offset, following the returned offset.

send and ask accept cc: ["name", ...]. to: is for whoever must act, and wakes them unless quiet: true requests next-turn or digest delivery. quiet is not for asks. cc: is for whoever should know: a quiet copy that does not wake. A send whose message or summary addresses a cc'd name (@name, or an "ask for name" line) is refused; pass ccOnPurpose: true if the cc is deliberate. reply defaults to reply-all; replyAll: false answers only the sender. To answer a message that arrived before this Pi's reader last started, add to: the asker's name. handled with replyTo confirms a relayed original to its desk without replying to the sender.

Give every send, ask and reply a summary: one line, at most 280 characters; longer is trimmed and the full text leads the message. Lead with the point or the ask. Phones and compact views show it first; the message holds the detail.

filter add|remove|list changes receiver wake and display rules only; operator mail and direct asks bypass filters.

A name held by another reader stays send-only, without background acquisition. claim retries that name once. RATKING_NAME=off disables name claims and leases. Forks mint their own derived names; they never inherit a parent's reader.

Usage:
  ${tool}({ action: "send", to: "name", summary: "...", message: "..." }) → Deliver a message
  ${tool}({ action: "send", to: "name", message: "...", encrypt: true }) → Deliver an encrypted message
  ${tool}({ action: "record", to: "name", type: "sh.mschf.agentgraph.checkin", record: { ... } }) → Validate then send typed data
  ${tool}({ action: "ask", to: "name", summary: "...", message: "..." }) → Ask and get the reply as a message; your turn is not blocked
  ${tool}({ action: "reply", replyTo: "<id>", summary: "...", message: "..." }) → Answer a message by its id
  ${tool}({ action: "pending" })                                     → Unanswered inbound asks and open outbound asks
  ${tool}({ action: "list", match: "muster/" })                     → Matching names, bounded
  ${tool}({ action: "list", all: true, limit: 50, offset: 0 })       → Full directory page with DIDs
  ${tool}({ action: "status" })                                      → This Pi's name and reader
  ${tool}({ action: "claim" })                                       → Retry a blocked name claim once
  ${tool}({ action: "attention" })                                   → Public status and private preferences; status/until/note sets status, prefs replaces preferences (Jev now/later use decimals 0..1)
  ${tool}({ action: "filter", op: "add", rule: { id: "quiet", match: { from: "project/*" }, route: "quiet" } }) → Add a rule; remove uses id, list shows local hits and expiry, 8/page via offset
  ${tool}({ action: "retire", successor: "name" })                   → Retire this Pi's own name; mail to it is refused naming the successor, and this reader stops`;

export const promptSnippet = (tool: string) =>
  `Message other agents over Rat King with ${tool}: send, async ask, reply by id, list the directory.`;

const readerText = (reader: ReaderState) =>
  ReaderState.$match(reader, {
    Acquiring: () => "acquiring lease",
    Live: ({ expiresAt, generation }) =>
      `live, lease generation ${generation} until ${expiresAt}`,
    Minting: ({ name }) => `minting ${name}`,
    Refused: ({ reason }) => `REFUSED: ${reason}`,
    Retrying: ({ attempt, reason }) =>
      `retrying (attempt ${attempt}): ${reason}`,
    SendOnly: ({ reason }) => `send-only: ${reason}`,
    Starting: () => "starting",
  });

export const STARTING_FOOTER = "🐀 starting";

export const IDENTITY_FOOTER = "🐀 identity";

export const offFooter = (reason: string) => `🐀 off · ${reason}`;

const footerText = (reader: ReaderState) =>
  ReaderState.$match(reader, {
    Acquiring: ({ name }) => `🐀 acquiring ${name}`,
    Live: ({ name }) => `🐀 live ${name}`,
    Minting: ({ name }) => `🐀 minting ${name}`,
    Refused: ({ reason }) => offFooter(`REFUSED: ${reason}`),
    Retrying: ({ attempt, reason }) =>
      `🐀 retrying (attempt ${attempt}): ${reason}`,
    SendOnly: ({ reason }) => `🐀 send-only · ${reason}`,
    Starting: () => IDENTITY_FOOTER,
  });

export const readerFooter = (reader: ReaderState) =>
  ReaderState.$is("Live")(reader) || ReaderState.$is("SendOnly")(reader)
    ? undefined
    : footerText(reader);

export const statusText = (_tool: string, status: Status) => {
  const self = Option.match(status.self, {
    onNone: () => "no identity yet",
    onSome: ({ did, name }) => `${name} (${did})`,
  });

  const reader = readerText(status.reader);

  const quarantine =
    status.quarantine.count === 0
      ? ""
      : ` · quarantined ${status.quarantine.count}${Option.match(
          status.quarantine.latest,
          {
            onNone: () => "",
            onSome: (latest) =>
              ` (latest seq ${latest.seq} from ${latest.senderDid}: ${latest.reason})`,
          }
        )}`;

  return `🐀 status: ${self} · reader ${reader}${quarantine} · mailbox ${status.endpoint}`;
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

const needMessage = (params: ToolParamsValue, lead?: string) =>
  Option.match(
    Option.fromNullishOr(
      withSummaryLead(lead, Option.getOrUndefined(withAttachments(params)))
    ),
    {
      onNone: () => Effect.fail(loud("Missing 'message' parameter")),
      onSome: Effect.succeed,
    }
  );

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
  params: ToolParamsValue,
  dispatch?: Dispatch,
  localHits: Effect.Effect<
    Readonly<Record<string, number>>,
    PlatformError | Schema.SchemaError
  > = Effect.succeed({}),
  onPhase?: PhaseReport
) {
  const ratking = tracked(yield* RatKing, dispatch);

  const { clamp, options: encryption } = sendingOptions(params);

  const lead = params.action === "record" ? undefined : clamp?.full;

  if (params.openProjectPaneIfMissing === true) {
    return loud(
      "openProjectPaneIfMissing is not available on Rat King; launch the agent first, then send."
    );
  }

  return yield* Match.value(params.action).pipe(
    Match.when("claim", () =>
      Effect.serviceOption(ReaderControl).pipe(
        Effect.flatMap((control) =>
          Option.match(control, {
            onNone: () =>
              Effect.succeed(
                loud("Reader claim is unavailable in this runtime")
              ),
            onSome: (reader) =>
              reader.claim.pipe(
                Effect.map((outcome) =>
                  ClaimOutcome.$match(outcome, {
                    Held: ({ holder }) =>
                      loud(
                        `Name claim not attempted: the lease is held by ${holder.session} (${holder.harness}, generation ${holder.generation}, expires ${holder.expiresAt}).`
                      ),
                    Idle: () =>
                      loud("No blocked name claim is waiting. Check status."),
                    Requested: () =>
                      ok(
                        "One explicit name claim requested. Check status for the lease outcome."
                      ),
                  })
                )
              ),
          })
        )
      )
    ),
    Match.when("status", () =>
      ratking.status.pipe(
        Effect.map((status) =>
          ReaderState.$is("Refused")(status.reader)
            ? loud(statusText(tool, status))
            : ok(statusText(tool, status))
        )
      )
    ),
    Match.whenOr("list", "list-cwd", () =>
      Effect.gen(function* list() {
        const status = yield* ratking.status;
        const entries = yield* ratking.list;

        const own = Option.getOrUndefined(
          status.self.pipe(Option.map(({ name }) => name))
        );

        return ok(listView(entries, own, params).text);
      })
    ),
    Match.when("filter", () =>
      Effect.gen(function* filter() {
        const input = yield* Schema.decodeUnknownEffect(FilterInput)(params);
        const rules = yield* filterRules(ratking.attention, input);
        const hits = yield* localHits;

        return ok(
          filterLines(
            rules,
            hits,
            params.offset ?? 0,
            Math.min(params.limit ?? 8, 8)
          ).join("\n")
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(loud(`Filter refused: ${String(error)}`))
        )
      )
    ),
    Match.when("attention", () =>
      ratking.attention(params).pipe(
        Effect.map((value) =>
          ok(
            JSON.stringify(
              { prefs: decimalPreferences(value.prefs), status: value.status },
              null,
              2
            )
          )
        ),
        Effect.catch((error) =>
          Effect.succeed(loud(`Attention refused: ${String(error)}`))
        )
      )
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
        Effect.flatMap((asks) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) =>
              asks.length === 0
                ? ok("No unresolved inbound or outbound asks.")
                : ok(
                    [
                      "**Inbound unanswered asks:**",
                      ...asks
                        .filter((ask) => ask.outbound === undefined)
                        .map(
                          (ask) => `- ${ask.from} · ${ask.id} · ${ask.preview}`
                        ),
                      "**Outbound open asks:**",
                      ...asks.flatMap((ask) =>
                        ask.outbound === undefined
                          ? []
                          : [
                              `- to ${ask.outbound.to} · ${ask.id} · ${ask.outbound.summary} · ${askAge(ask.outbound, now)} · dueBy ${ask.outbound.dueBy === undefined ? "none" : DateTime.formatIso(DateTime.makeUnsafe(ask.outbound.dueBy))}`,
                            ]
                      ),
                    ].join("\n"),
                    { pending: asks.length }
                  )
            )
          )
        )
      )
    ),
    Match.when("handled", () =>
      Effect.gen(function* handled() {
        if (params.replyTo === undefined) {
          return loud("Pass replyTo: the original id of the relayed message.");
        }

        const delivered = yield* ratking.handled(params.replyTo);

        if ("acked" in delivered) {
          return ok(
            `Handled recorded for ${delivered.id}: this Pi no longer holds the relayed message, so its delivery was acknowledged and no confirmation was sent to the desk.`,
            { acked: true, id: delivered.id, replyTo: params.replyTo }
          );
        }

        return ok(
          `Handled confirmed to ${delivered.to} (id ${delivered.id}, seq ${delivered.seq}).`,
          { id: delivered.id, replyTo: params.replyTo, seq: delivered.seq }
        );
      })
    ),
    Match.when("reply", () =>
      Effect.gen(function* reply() {
        const message = yield* needMessage(params, lead);

        const pending = (yield* ratking.pending).filter(
          (ask) => ask.outbound === undefined
        );

        const target =
          params.replyTo ?? (pending.length === 1 ? pending[0]?.id : undefined);

        if (target === undefined) {
          return loud(
            pending.length === 0
              ? "No pending ask to reply to; pass replyTo from the message, or use send."
              : `Several asks are pending; pass replyTo: ${pending.map((ask) => ask.id).join(", ")}`
          );
        }

        const delivered = yield* ratking.reply(
          target,
          message,
          dispatching(
            {
              ...encryption,
              replyAll: params.replyAll ?? true,
              to: params.to,
            },
            dispatch,
            onPhase
          )
        );

        return ok(
          withPresence(receiptText("Reply delivered to", delivered), delivered),
          {
            id: delivered.id,
            recipients: recipientsOf(delivered),
            replyTo: target,
            seq: delivered.seq,
            to: delivered.to,
            ...presenceDetails(delivered),
          }
        );
      })
    ),
    Match.when("record", () =>
      Effect.gen(function* record() {
        const value = yield* validateRecord(params.type, params.record).pipe(
          Effect.mapError((error) => loud(invalidRecordText(error)))
        );

        const to = yield* needTo(params);

        const body =
          value.$type === "sh.mschf.agentgraph.wake"
            ? yield* Schema.decodeUnknownEffect(LexiconRecord)(value).pipe(
                Effect.mapError((error) => loud(error.message))
              )
            : JSON.stringify(value);

        const delivered = yield* ratking.send(
          to,
          body,
          dispatching<SendOptions>(
            {
              ...encryption,
              cc: params.cc ?? [],
              kind: "data",
              summary: params.summary ?? recordSummary(value),
            },
            dispatch,
            onPhase
          )
        );

        return ok(
          `Record delivered to ${delivered.to} over Rat King (id ${delivered.id}, seq ${delivered.seq}).`,
          { id: delivered.id, seq: delivered.seq, to: delivered.to }
        );
      })
    ),
    Match.when("send", () =>
      Effect.gen(function* send() {
        const to = yield* needTo(params);
        const message = yield* needMessage(params, lead);

        const delivered = yield* ratking.send(
          to,
          message,
          dispatching({ ...encryption, cc: params.cc ?? [] }, dispatch, onPhase)
        );

        return ok(
          withPresence(receiptText("Delivered to", delivered), delivered),
          {
            id: delivered.id,
            recipients: recipientsOf(delivered),
            seq: delivered.seq,
            to: delivered.to,
            ...presenceDetails(delivered),
          }
        );
      })
    ),
    Match.when("ask", () =>
      Effect.gen(function* ask() {
        const to = yield* needTo(params);
        const message = yield* needMessage(params, lead);

        const askOptions: AskOptions = dispatching(
          { ...encryption, cc: params.cc ?? [] },
          dispatch,
          onPhase
        );

        if (params.dueBy !== undefined) {
          Object.assign(askOptions, { dueBy: params.dueBy });
        }

        if (params.wait !== undefined) {
          Object.assign(askOptions, { wait: params.wait });
        }

        if (params.wait === true && dispatch !== undefined) {
          Object.assign(askOptions, {
            onDelivered: Ref.set(dispatch, "delivered"),
          });
        }

        const { delivered, reply } = yield* ratking.ask(
          to,
          message,
          params.wait === true
            ? `${params.timeoutSeconds ?? 600} seconds`
            : askTimeout,
          askOptions
        );

        if (reply === undefined) {
          return ok(
            withPresence(
              `✓ asked ${delivered.to} · ${delivered.id.slice(0, 8)}\nThe reply arrives as a message; your turn is not blocked.`,
              delivered
            ),
            {
              id: delivered.id,
              recipients: recipientsOf(delivered),
              seq: delivered.seq,
              to: delivered.to,
            }
          );
        }

        return ok(
          [
            ...(recipientsOf(delivered).length > 1
              ? [receiptText("Delivered to", delivered), ""]
              : []),
            `**Reply from ${reply.from}** (id ${reply.id}):\n${reply.body}`,
          ].join("\n"),
          {
            id: delivered.id,
            recipients: recipientsOf(delivered),
            replyId: reply.id,
            seq: delivered.seq,
            to: delivered.to,
          }
        );
      })
    ),
    Match.when("retire", () =>
      Effect.gen(function* retire() {
        const retired = yield* retireOwn(ratking, params.successor);

        return ok(
          `Retired ${retired.name} at ${retired.retiredAt}. Mail to it is now refused${
            retired.successor === undefined
              ? ""
              : `, naming ${retired.successor} as the current row`
          }. This reader stops; a new session under this name acquires its lease and clears the retirement.`,
          { name: retired.name, retired: true }
        );
      })
    ),
    Match.exhaustive,
    Deadline.timeoutOrElse({
      duration:
        params.action === "ask" && params.wait === true
          ? Math.min(
              600_000,
              Math.max(1, (params.timeoutSeconds ?? 600) * 1000)
            )
          : Deadline.OPERATION_MS,
      orElse: () =>
        Effect.succeed(
          loud(
            "Caller deadline exceeded. A dispatched message may have reached the mailbox; check pending/inbox before resending."
          )
        ),
    }),
    Effect.map((result) =>
      clamp === undefined || result.isError
        ? result
        : { ...result, text: `${result.text}\n${clamp.note}` }
    ),
    Effect.catchTags({
      AskFailed: (error) =>
        Effect.succeed(
          loud(`${error.code}: ${error.reason}`, { code: error.code })
        ),
      NotDelivered: (error) =>
        Effect.succeed(
          loud(
            error.addressed === undefined
              ? notDeliveredText(error)
              : ccRefusalPrompt({
                  action: params.action,
                  addressed: error.addressed,
                  call: (call) => toolCall(tool, call),
                }),
            { code: error.code }
          )
        ),
      QuietAsk: (error) =>
        Effect.succeed(
          loud(
            literalPrompt({
              accepted: "quiet messages and replies; asks without quiet",
              debug: error.debug,
              fix: error.fix,
              tag: error._tag,
              why: error.why,
            }),
            { code: error._tag }
          )
        ),
    }),
    Effect.match({ onFailure: (text) => text, onSuccess: (text) => text })
  );
});

export const notConfiguredText = (error: NotConfigured) =>
  loud(`NOT DELIVERED: NotConfigured. ${error.reason}.`, {
    code: "NotConfigured",
  });
