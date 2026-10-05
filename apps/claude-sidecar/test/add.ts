/* oxlint-disable typescript/promise-function-async -- pi-durable's tool interface returns a Promise. */
import { defineTool } from "@earendil-works/pi-durable";
import { Schema } from "effect";

export const add = defineTool({
  description: "Add two numbers",
  execute: (input) => {
    const args = Schema.decodeUnknownSync(
      Schema.Struct({ a: Schema.Finite, b: Schema.Finite })
    )(input);

    return Promise.resolve({
      content: [{ text: String(args.a + args.b), type: "text" }],
    });
  },
  name: "add",
  parameters: {
    additionalProperties: false,
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
    type: "object",
  },
  replay: "safe",
});
