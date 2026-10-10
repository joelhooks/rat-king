import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Option, Schema } from "effect";

import { Kind, renderInbound } from "./payload.ts";

const Details = Schema.Struct({
  body: Schema.String,
  cc: Schema.Boolean,
  did: Schema.String,
  from: Schema.String,
  id: Schema.String,
  kind: Kind,
  label: Schema.optional(Schema.String),
  replyTo: Schema.optional(Schema.String),
  verified: Schema.Boolean,
});

const oneLine = (text: string) =>
  stripTerminalSequences(text).replaceAll(/[\r\n\t]+/gu, " ");

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
        ...value,
        label: Option.fromNullishOr(value.label),
        replyTo: Option.fromNullishOr(value.replyTo),
      };

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

          const markers = [
            ...(value.verified ? [] : ["unverified"]),
            ...(value.cc ? ["CC"] : []),
            ...(value.replyTo === undefined ? [] : ["↩ in reply to"]),
          ];

          const suffix = ` · ${oneLine(value.id)}`;

          const markerText = markers.map((marker) => ` · ${marker}`).join("");

          const sender = truncateToWidth(
            oneLine(value.label ?? value.from),
            Math.max(
              0,
              width -
                visibleWidth(suffix) -
                visibleWidth(markerText) -
                visibleWidth("📨 ") -
                3
            )
          );

          const heading = truncateToWidth(
            `📨 ${sender}${markerText}`,
            Math.max(0, width - visibleWidth(suffix) - 3)
          );

          const body = truncateToWidth(
            oneLine(value.body.split(/\r?\n/u)[0] ?? ""),
            Math.max(
              0,
              width - visibleWidth(heading) - visibleWidth(suffix) - 3
            )
          );

          const line = truncateToWidth(`${heading} · ${body}${suffix}`, width);

          text.setText(input.theme.fg("customMessageText", line));

          return text.render(width);
        },
      };
    }),
    Option.getOrUndefined
  );
};
