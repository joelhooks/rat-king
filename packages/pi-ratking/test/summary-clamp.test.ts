import { it } from "@effect/vitest";
import {
  PayloadJson,
  SUMMARY_HARD_MAX,
  SUMMARY_MAX,
  SUMMARY_WIRE_MAX,
} from "@rat-king/ratking-client/payload";
import type { LexiconRecordValue } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import { normalizeSummary } from "@rat-king/ratking-client/summary";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { runAction } from "../src/tool.ts";
import type { ToolParamsValue } from "../src/tool.ts";

const loneSurrogate = /[\uD800-\uDFFF]/u;

const wireBody = (length: number) =>
  JSON.stringify({
    body: "b",
    from: "acme/desk",
    summary: "s".repeat(length),
  });

interface Sent {
  readonly body: string;
  readonly encrypt: boolean | undefined;
  readonly summary: string | undefined;
}

const Piece = Schema.Literals(["a", "bb", "word", "😀", "👍🏽", " ", "\n", "é"]);

const Pieces = Schema.Array(Piece).check(Schema.isMinLength(1));

const Action = Schema.Literals(["send", "ask", "reply"]);

const harness = () => {
  const sent: Sent[] = [];
  const unavailable = Effect.die("Unexpected service call");

  const delivered = {
    did: "did:web:acme.example.invalid",
    id: "msg-1",
    seq: 1,
    to: "acme/desk",
  };

  const record = (
    body: string | LexiconRecordValue,
    options:
      | { readonly encrypt?: boolean; readonly summary?: string }
      | undefined
  ) =>
    sent.push({
      body: Schema.is(Schema.String)(body) ? body : "",
      encrypt: options?.encrypt,
      summary: options?.summary,
    });

  const service = RatKing.of({
    ask: (_to, body, _timeout, options) =>
      Effect.sync(() => {
        record(body, options);

        return {
          delivered,
          reply: { body: "ok", did: delivered.did, from: "acme/desk", id: "r" },
        };
      }),
    attention: () => Effect.die("Unexpected attention call"),
    handled: () => unavailable,
    list: unavailable,
    pending: Effect.succeed([]),
    reply: (_id, body, options) =>
      Effect.sync(() => {
        record(body, options);

        return delivered;
      }),
    retire: () => unavailable,
    roles: unavailable,
    run: () => unavailable,
    send: (_to, body, options) =>
      Effect.sync(() => {
        record(body, options);

        return delivered;
      }),
    status: unavailable,
  });

  return { sent, service };
};

const run = (
  action: typeof Action.Type,
  summary: string,
  message: string | undefined,
  encrypt = false
) => {
  const { sent, service } = harness();

  const params: ToolParamsValue = {
    action,
    encrypt,
    replyTo: "msg-0",
    summary,
    to: "acme/desk",
  };

  if (message !== undefined) {
    Object.assign(params, { message });
  }

  return runAction("intercom", 1000, params).pipe(
    Effect.provideService(RatKing, service),
    Effect.map((result) => ({ result, sent }))
  );
};

const isUntouched = (summary: string) =>
  normalizeSummary(summary).length <= SUMMARY_WIRE_MAX;

it.effect.prop(
  "any summary goes out within the wire cap, well formed, and the full text is never lost",
  [
    Action,
    Pieces,
    Schema.Int.check(Schema.isBetween({ maximum: 90, minimum: 1 })),
    Schema.Boolean,
  ],
  ([action, pieces, copies, encrypt]) =>
    Effect.gen(function* clamp() {
      const summary = Array.from({ length: copies }, () =>
        pieces.join("")
      ).join(" ");

      const { result, sent } = yield* run(action, summary, "detail", encrypt);
      const [only] = sent;

      expect(result.isError).toBe(false);
      expect(sent).toHaveLength(1);
      expect(only?.encrypt).toBe(encrypt);
      expect(normalizeSummary(only?.summary ?? "").length).toBeLessThanOrEqual(
        SUMMARY_WIRE_MAX
      );
      expect(loneSurrogate.test(only?.summary ?? "")).toBe(false);

      if (isUntouched(summary)) {
        expect(only?.summary).toBe(summary);
        expect(only?.body).toBe("detail");
        expect(result.text).not.toContain("trimmed");
      } else {
        expect(only?.summary?.endsWith("…")).toBe(true);
        expect(only?.body).toBe(`${summary.trim()}\n\ndetail`);
        expect(result.text).toContain(
          `summary trimmed to ${only?.summary?.length} characters; the full text leads the message.`
        );
      }
    })
);

it.effect.prop(
  "an emoji straddling the cut is dropped whole, never split",
  [
    Schema.Int.check(Schema.isBetween({ maximum: 285, minimum: 270 })),
    Schema.Literals(["😀", "👍🏽", "𝒳"]),
  ],
  ([lead, emoji]) =>
    Effect.gen(function* straddle() {
      const summary = `${"a".repeat(lead)}${emoji.repeat(20)}`;
      const { sent } = yield* run("send", summary, "m");

      expect(loneSurrogate.test(sent[0]?.summary ?? "")).toBe(false);
      expect(sent[0]?.summary?.length).toBeLessThanOrEqual(SUMMARY_WIRE_MAX);
      expect(sent[0]?.body.startsWith(summary)).toBe(true);
    })
);

it.effect.prop(
  "the boundary lengths 279, 280, 281 and 2000 behave as stated",
  [Schema.Literals([279, 280, 281, 2000])],
  ([length]) =>
    Effect.gen(function* edges() {
      const summary = "s".repeat(length);

      const { result, sent } = yield* run(
        "send",
        summary,
        length > SUMMARY_MAX ? undefined : "m"
      );

      if (length <= SUMMARY_MAX) {
        expect(sent[0]?.summary).toBe(summary);
        expect(sent[0]?.body).toBe("m");
      } else {
        expect(sent[0]?.summary).toBe(`${"s".repeat(SUMMARY_MAX - 1)}…`);
        expect(sent[0]?.body).toBe(summary);
        expect(result.text).toContain("summary trimmed to 280 characters");
      }
    })
);

it.effect.prop(
  "a long summary with spaces is cut at a word boundary",
  [Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: 1 }))],
  ([words]) =>
    Effect.gen(function* boundary() {
      const summary = Array.from({ length: words * 10 }, () => "wordy").join(
        " "
      );

      const { sent } = yield* run("send", summary, "m");
      const trimmed = sent[0]?.summary ?? "";

      if (!isUntouched(summary)) {
        expect(trimmed.endsWith("wordy…")).toBe(true);
        expect(summary.startsWith(trimmed.slice(0, -1))).toBe(true);
      }
    })
);

it("readers accept up to the hard max, and an older 280-cap reader would not", () => {
  const OldPayload = Schema.fromJsonString(
    Schema.Struct({
      body: Schema.String,
      from: Schema.String,
      summary: Schema.optionalKey(
        Schema.String.check(Schema.isMaxLength(SUMMARY_MAX))
      ),
    })
  );

  expect(
    Schema.decodeUnknownResult(PayloadJson)(wireBody(SUMMARY_HARD_MAX))._tag
  ).toBe("Success");
  expect(
    Schema.decodeUnknownResult(PayloadJson)(wireBody(SUMMARY_HARD_MAX + 1))._tag
  ).toBe("Failure");
  expect(Schema.decodeUnknownResult(PayloadJson)(wireBody(281))._tag).toBe(
    "Success"
  );
  expect(Schema.decodeUnknownResult(OldPayload)(wireBody(281))._tag).toBe(
    "Failure"
  );
  expect(
    Schema.decodeUnknownResult(OldPayload)(wireBody(SUMMARY_WIRE_MAX))._tag
  ).toBe("Success");
});
