import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

import { sendIfOpen } from "../src/socket.ts";

const ReadyState = Schema.Literals([0, 1, 2, 3]);

it.prop(
  "a notice reaches a socket only while it is open and never throws on a closing one",
  { readyState: ReadyState, text: Schema.String },
  ({ readyState, text }) => {
    const sent: string[] = [];

    const socket = {
      readyState,
      send: (value: string) => {
        if (readyState !== 1) {
          throw new TypeError("Can't call WebSocket send() after close().");
        }

        sent.push(value);
      },
    };

    sendIfOpen(socket, text);

    expect(sent).toEqual(readyState === 1 ? [text] : []);
  }
);
