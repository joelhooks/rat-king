import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Turn } from "@rat-king/lexicon/turns";
import { compactRecord } from "@rat-king/ratking-client/agentgraph";
import { formatReason, isOperator } from "@rat-king/ratking-client/attend";
import {
  DeliveryReason,
  storedReason,
} from "@rat-king/ratking-client/delivery";
import {
  COPY_NOTE,
  Kind,
  PassSource,
  passMarker,
  RelaySource,
  renderInboundBody,
  replyHint,
} from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { Match, Option, Schema } from "effect";

import {
  clean,
  clip,
  noLabels,
  oneLine,
  paragraphs,
  terminalStyles,
} from "./tui.ts";
import type { Labels, Paint } from "./tui.ts";
import { Block, GUTTER } from "./ui/block.ts";
import { BRAND } from "./ui/brand.ts";
import { mailParty } from "./ui/mail-party.ts";
import { Party } from "./ui/party.ts";

const Details = Schema.Struct({
  body: Schema.String,
  cc: Schema.Boolean,
  ccNames: Schema.optional(Schema.Array(Schema.String)),
  delegatedFor: Schema.optional(Schema.String),
  delegatedTo: Schema.optional(Schema.String),
  did: Schema.String,
  from: Schema.String,
  id: Schema.String,
  kind: Kind,
  label: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.Union([DeliveryReason, Schema.String])),
  relay: Schema.optional(RelaySource),
  replyTo: Schema.optional(Schema.String),
  sentBy: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  thread: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  verified: Schema.Boolean,
  via: Schema.optional(PassSource),
});

export type InboundView = typeof Details.Type;

export const COMPACT_LINES = 4;

export interface InboundInput {
  readonly expanded: boolean;
  readonly labels?: Labels;
  readonly theme: Paint;
  readonly tool: string;
  readonly value: InboundView;
  readonly width: number;
}

export interface MessageInput {
  readonly details: unknown;
  readonly expanded: boolean;
  readonly labels?: Labels;
  readonly theme: Paint;
  readonly tool: string;
}

const deliveryStatus = (value: InboundView): string => {
  if (value.kind === "ask") {
    return "ask";
  }

  if (value.kind === "reply") {
    return "reply";
  }

  return value.cc ? "cc" : "to";
};

const defaultReason = (value: InboundView): string => {
  if (value.cc && value.kind !== "ask") {
    return "quiet: cc";
  }

  return `woken: ${deliveryStatus(value)}`;
};

const reasonText = (value: InboundView): string => {
  const reason = storedReason(value.reason);

  return reason === undefined
    ? Match.value(value.reason).pipe(
        Match.when(Match.string, oneLine),
        Match.orElse(() => defaultReason(value))
      )
    : formatReason(reason);
};

const footer = (value: InboundView, expanded: boolean): string =>
  [
    `id ${oneLine(value.id)}`,
    reasonText(value),
    value.delegatedFor === undefined
      ? undefined
      : `for ${oneLine(value.delegatedFor)}`,
    value.delegatedTo === undefined
      ? undefined
      : `handled by ${oneLine(value.delegatedTo)}`,
    value.relay === undefined ? undefined : `via ${oneLine(value.relay.name)}`,
    value.relay?.encrypted === true ? "encrypted" : undefined,
    value.verified ? undefined : `unverified sender ${oneLine(value.did)}`,
    value.replyTo === undefined ? undefined : `↩ ${oneLine(value.replyTo)}`,
    value.sentBy === undefined ? undefined : `sent by ${oneLine(value.sentBy)}`,
    value.ccNames === undefined
      ? undefined
      : `cc ${value.ccNames.map(oneLine).join(", ")}`,
    value.thread === undefined ? undefined : `thread ${oneLine(value.thread)}`,
    expanded ? undefined : "ctrl+o expands",
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

const hints = (value: InboundView, tool: string): readonly string[] => {
  if (value.sentBy !== undefined) {
    return [
      `Context only: ${oneLine(value.sentBy)} already sent this. No reply needed.`,
    ];
  }

  const inbound: Inbound = {
    body: value.body,
    cc: value.cc,
    did: value.did,
    from: value.from,
    id: value.id,
    kind: value.kind,
    label: Option.none(),
    replyTo: Option.fromNullishOr(value.replyTo),
    summary: Option.fromNullishOr(value.summary),
    verified: value.verified,
  };

  if (value.relay !== undefined) {
    Object.assign(inbound, { relay: value.relay });
  }

  return [
    ...(value.cc ? [COPY_NOTE] : []),
    ...clean(replyHint(tool, inbound)).split("\n"),
  ];
};

const turnLines = (input: InboundInput): readonly string[] | undefined => {
  if (input.value.kind !== "data") {
    return undefined;
  }

  const turn = Schema.decodeUnknownOption(Schema.fromJsonString(Turn))(
    input.value.body
  );

  if (
    Option.isNone(turn) ||
    !input.value.verified ||
    (!isOperator({
      from: input.value.from,
      kind: input.value.kind,
      verified: input.value.verified,
    }) &&
      turn.value.agent !== input.value.from)
  ) {
    return undefined;
  }

  const { value } = turn;

  const glyphs = {
    blocked: "!",
    crashed: "✗",
    done: "✓",
    idle: "⋯",
    working: "⋯",
  };

  return Block({
    body: [
      oneLine(value.reason ?? value.stopReason ?? input.value.summary ?? ""),
    ],
    footer: `turn ${oneLine(value.turnId)}`,
    glyph: glyphs[value.state],
    headline: `${oneLine(value.agent)} · ${value.state}`,
    theme: input.theme,
    width: input.width,
  });
};

const previewBody = (
  value: InboundView,
  expanded: boolean,
  tool: string
): string => {
  if (value.kind === "data" && !expanded && !value.cc) {
    return Option.getOrElse(compactRecord(value.body), () => value.body);
  }

  const body = renderInboundBody(tool, value);
  const summary = clean(value.summary ?? "").trim();
  const text = clean(body).trimStart();

  return value.kind !== "data" && summary !== "" && text.startsWith(summary)
    ? text.slice(summary.length).trimStart()
    : body;
};

const statusGlyph = (value: InboundView): string => {
  if (value.kind === "reply") {
    return "↩";
  }

  return value.cc ? "⋯" : "✓";
};

export const inboundLines = (input: InboundInput): readonly string[] => {
  if (input.width <= 0) {
    return [];
  }

  const turn = turnLines(input);

  if (turn !== undefined) {
    return turn;
  }

  const { expanded, theme, value, width } = input;
  const room = Math.max(1, width - GUTTER);
  const label = value.label ?? (input.labels ?? noLabels)(value.from);

  const name = Party({
    label: mailParty({ ...value, label }),
    name: value.from,
    theme,
  });

  const recipient = Party({
    label: mailParty({
      ...value,
      from: value.to ?? "unknown",
      label: (input.labels ?? noLabels)(value.to ?? "unknown"),
      verified: false,
    }),
    name: value.to ?? "unknown",
    theme,
  });

  const headline = `${value.sentBy === undefined ? "from" : "sent to"} ${value.sentBy === undefined ? name : recipient}${value.summary === undefined ? "" : ` · ${oneLine(value.summary)}`}`;

  const bodyText = previewBody(value, expanded, input.tool);

  const body = paragraphs(
    value.via === undefined
      ? bodyText
      : `${passMarker(value.via)}\n\n${bodyText}`,
    room
  ).map((line) => theme.fg("customMessageText", line));

  const status = statusGlyph(value);

  return Block({
    body: expanded
      ? [
          ...body,
          ...hints(value, input.tool).map((line) => theme.fg("dim", line)),
        ]
      : clip(theme, body, 2, room),
    footer: footer(value, expanded),
    glyph: `${BRAND}${value.verified ? status : "⚠"}`,
    headline,
    theme,
    width,
  }).map((line) => truncateToWidth(line, width, "…"));
};

export const messageView = (input: MessageInput): Component | undefined =>
  Schema.decodeUnknownOption(Details)(input.details).pipe(
    Option.map((value) => {
      let cache: { width: number; lines: string[] } | undefined;

      return {
        invalidate() {
          cache = undefined;
        },
        render(width: number) {
          if (cache?.width !== width) {
            cache = {
              lines: inboundLines({ ...input, value, width }).map(
                terminalStyles
              ),
              width,
            };
          }

          return cache.lines;
        },
      };
    }),
    Option.getOrUndefined
  );
