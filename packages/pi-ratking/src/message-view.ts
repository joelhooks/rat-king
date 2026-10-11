import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Option, Schema } from "effect";

import { Kind, RelaySource, renderInbound } from "./payload.ts";

const Details = Schema.Struct({
  body: Schema.String,
  cc: Schema.Boolean,
  ccNames: Schema.optional(Schema.Array(Schema.String)),
  did: Schema.String,
  from: Schema.String,
  id: Schema.String,
  kind: Kind,
  label: Schema.optional(Schema.String),
  relay: Schema.optional(RelaySource),
  replyTo: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  thread: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  verified: Schema.Boolean,
});

const oneLine = (text: string) =>
  stripTerminalSequences(text).replaceAll(/[\r\n\t]+/gu, " ");

export const COMPACT_LINES = 4;

const plain = (text: string) =>
  stripTerminalSequences(text).replaceAll(/[\r\t]+/gu, " ");

export const compactLines = (
  value: {
    readonly body: string;
    readonly cc: boolean;
    readonly ccNames?: readonly string[] | undefined;
    readonly relay?: typeof RelaySource.Type | undefined;
    readonly from: string;
    readonly label?: string | undefined;
    readonly replyTo?: string | undefined;
    readonly summary?: string | undefined;
    readonly verified: boolean;
  },
  width: number
): readonly string[] => {
  let ccMarker = value.cc ? ["CC"] : [];

  if ((value.ccNames?.length ?? 0) > 0) {
    ccMarker = [`cc: ${(value.ccNames ?? []).map(oneLine).join(", ")}`];
  }

  const markers = [
    ...(value.verified ? [] : ["unverified"]),
    ...(value.relay === undefined ? [] : [`via ${oneLine(value.relay.name)}`]),
    ...ccMarker,
    ...(value.replyTo === undefined ? [] : ["↩"]),
  ];

  const markerText = markers.map((marker) => ` · ${marker}`).join("");

  const sender = truncateToWidth(
    oneLine(value.label ?? value.from),
    Math.max(1, width - visibleWidth("📨 ") - visibleWidth(markerText))
  );

  const heading = truncateToWidth(`📨 ${sender}${markerText}`, width);

  const source = plain(value.summary ?? value.body).trim();

  const wrapped = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .flatMap((line) => wrapTextWithAnsi(line, width));

  const room = COMPACT_LINES - 1;

  if (wrapped.length <= room) {
    return [heading, ...wrapped];
  }

  const hidden = wrapped.length - (room - 1);

  const more = ` … +${hidden} line${hidden === 1 ? "" : "s"}`;

  const last = truncateToWidth(
    wrapped[room - 1] ?? "",
    Math.max(0, width - visibleWidth(more)),
    ""
  );

  return [
    heading,
    ...wrapped.slice(0, room - 1),
    truncateToWidth(`${last}${more}`, width),
  ];
};

export const messageView = (input: {
  readonly details: unknown;
  readonly expanded: boolean;
  readonly theme: Pick<Theme, "fg">;
  readonly tool: string;
}): Component | undefined => {
  const details = Schema.decodeUnknownOption(Details)(input.details);

  return details.pipe(
    Option.map((value) => {
      const inbound = {
        body: value.body,
        cc: value.cc,
        did: value.did,
        from: value.from,
        id: value.id,
        kind: value.kind,
        label: Option.fromNullishOr(value.label),
        replyTo: Option.fromNullishOr(value.replyTo),
        summary: Option.fromNullishOr(value.summary),
        verified: value.verified,
      };

      if (value.relay !== undefined) {
        Object.assign(inbound, { relay: value.relay });
      }

      if (value.ccNames !== undefined) {
        Object.assign(inbound, { ccNames: value.ccNames });
      }

      if (value.thread !== undefined) {
        Object.assign(inbound, { thread: value.thread });
      }

      if (value.to !== undefined) {
        Object.assign(inbound, { to: value.to });
      }

      const text = new Text("", 0, 0);

      return {
        invalidate() {
          text.invalidate();
        },
        render(width: number) {
          if (width <= 0) {
            return [];
          }

          if (input.expanded) {
            text.setText(
              input.theme.fg(
                "customMessageText",
                renderInbound(input.tool, inbound)
              )
            );

            return text.render(width);
          }

          return compactLines(value, width).map((line, index) =>
            input.theme.fg(index === 0 ? "dim" : "customMessageText", line)
          );
        },
      };
    }),
    Option.getOrUndefined
  );
};
