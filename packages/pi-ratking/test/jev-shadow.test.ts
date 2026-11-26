import { it } from "@effect/vitest";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { Clock, Deferred, Effect, Option, Schema } from "effect";
import { expect } from "vitest";

import { defaultPreferences } from "../../mailbox-client/src/attention.ts";
import { shadowReport } from "../src/jev-shadow-report.ts";
import { PRIVATE_NAMES, mappedRoute, shadowReader } from "../src/jev-shadow.ts";
import type {
  ClassifyJev,
  JevQuestion,
  ShadowRowValue,
} from "../src/jev-shadow.ts";
import { MAIL_MESSAGE } from "../src/pending.ts";

const mail = (id: string): Inbound => ({
  body: "body marker that must never appear in the journal",
  cc: true,
  did: "did:web:worker.example.invalid",
  encrypted: false,
  from: "fleet/worker",
  id,
  kind: "ask",
  label: Option.none(),
  quiet: true,
  replyTo: Option.none(),
  summary: Option.some("summary marker that must never appear in the journal"),
  verified: true,
});

const model = (body: "never" | "summary" | "full", timeoutMs = 2000) => ({
  prefs: {
    ...defaultPreferences(),
    model: {
      body,
      jev: { judgment: "custom judgment", laterBp: 3000, nowBp: 9000 },
      kind: "jev" as const,
      timeoutMs,
    },
  },
});

const success = { inputTokens: 290, outputTokens: 3, probability: 0.8 };

const message = (id: string) => ({
  customType: MAIL_MESSAGE,
  details: { id },
  role: "custom",
});

it.live.prop(
  "encrypt and private namespaces never invoke the provider, including relayed mail and an EA reader",
  [Schema.String],
  ([sentinel]) =>
    Effect.gen(function* privacyExclusions() {
      let calls = 0;

      const classify = () =>
        Effect.sync(() => {
          calls += 1;

          return success;
        });

      const base = {
        ...mail("private"),
        body: sentinel,
        levers: model("full"),
      };

      const privateCases = [
        ...PRIVATE_NAMES.map(({ name, reason }) => ({
          inbound: { ...base, from: `${name}/worker` },
          reader: "fleet/desk",
          reason,
        })),
        {
          inbound: { ...base, encrypted: true },
          reader: "fleet/desk",
          reason: "encrypted",
        },
        {
          inbound: {
            ...base,
            relay: { did: base.did, encrypted: true, name: "fleet/source" },
          },
          reader: "fleet/desk",
          reason: "encrypted",
        },
        { inbound: base, reader: "switchboard/ea", reason: "ea" },
      ];

      for (const { inbound, reader, reason } of privateCases) {
        const complete = yield* Deferred.make<ShadowRowValue>();

        const shadow = shadowReader({
          append: (_reader, row) =>
            Deferred.succeed(complete, row).pipe(Effect.asVoid),
          classify,
          envEnabled: true,
          reader: () => reader,
        });

        shadow.observe(inbound, "Now", 0);
        expect(yield* Deferred.await(complete)).toMatchObject({
          probability: null,
          skipped: reason,
        });
      }

      expect(calls).toBe(0);
    }),
  { arbitrary: { runs: 15 } }
);

it.live.prop(
  "reader preferences opt in, control the question and disclose only the requested field; a repeat ID isn't scored twice",
  [Schema.Literals(["summary", "never", "full", "env"])],
  ([policy]) =>
    Effect.gen(function* scorePreferences() {
      const complete = yield* Deferred.make<ShadowRowValue>();
      const questions: JevQuestion[] = [];
      const inbound = mail("message");

      const shadow = shadowReader({
        append: (_reader, row) =>
          Deferred.succeed(complete, row).pipe(Effect.asVoid),
        classify: (question) =>
          Effect.sync(() => {
            questions.push(question);

            return success;
          }),
        envEnabled: policy === "env",
        reader: () => "fleet/desk",
      });

      const arrival =
        policy === "env" ? inbound : { ...inbound, levers: model(policy) };

      shadow.observe(arrival, "Next", 0);
      shadow.observe(arrival, "Now", 1);
      expect(questions).toHaveLength(0);
      const score = yield* Deferred.await(complete);
      expect(questions).toHaveLength(1);
      expect(questions[0]?.state).toMatchObject({
        kind: "ask",
        quiet: true,
        role: "cc",
        sender: inbound.from,
        summary: Option.getOrThrow(inbound.summary),
      });
      expect(questions[0]?.state.body).toBe(
        policy === "full" ? inbound.body : undefined
      );
      expect(questions[0]?.judgment).toBe(
        policy === "env"
          ? "Does this message need attention or an answer now?"
          : "custom judgment"
      );
      expect(score).toMatchObject({
        ...success,
        rule: "Next",
        verdict: policy === "env" ? "now" : "later",
      });
      expect(JSON.stringify(score)).not.toContain(inbound.body);
      expect(JSON.stringify(score)).not.toContain(
        Option.getOrThrow(inbound.summary)
      );
    }),
  { arbitrary: { runs: 15 } }
);

it.live.prop(
  "missing key, provider failure (including defects), and timeout produce only bounded skip rows",
  [Schema.Literals(["no-key", "provider-error", "defect", "timeout"])],
  ([failure]) =>
    Effect.gen(function* failOpen() {
      const complete = yield* Deferred.make<ShadowRowValue>();
      const interrupted = yield* Deferred.make<boolean>();
      const inbound = mail("failure");

      const failures: Record<typeof failure, ReturnType<ClassifyJev>> = {
        defect: Effect.die(inbound.body),
        "no-key": Effect.fail("no-key"),
        "provider-error": Effect.fail("provider-error"),
        timeout: Effect.never.pipe(
          Effect.onInterrupt(() =>
            Deferred.succeed(interrupted, true).pipe(Effect.asVoid)
          )
        ),
      };

      const shadow = shadowReader({
        append: (_reader, row) =>
          Deferred.succeed(complete, row).pipe(Effect.asVoid),
        classify: () => failures[failure],
        envEnabled: false,
        reader: () => "fleet/desk",
      });

      shadow.observe(
        { ...inbound, levers: model("full", failure === "timeout" ? 1 : 2000) },
        "Now",
        0
      );
      const row = yield* Deferred.await(complete);
      expect(row).toMatchObject({
        probability: null,
        rule: "Now",
        skipped: failure === "defect" ? "provider-error" : failure,
      });
      expect(JSON.stringify(row)).not.toContain(inbound.body);

      if (failure === "timeout") {
        expect(yield* Deferred.poll(interrupted)).not.toEqual(Option.none());
      }
    }),
  { arbitrary: { runs: 15 } }
);

it.live.prop(
  "only offered mail that reaches the woken turn joins its tool/send/text outcome, even when the score comes later",
  [Schema.Literals(["tool", "send", "text", "empty", "not-shown"])],
  ([response]) =>
    Effect.gen(function* joinTurn() {
      const permit = yield* Deferred.make<boolean>();
      const done = yield* Deferred.make<ShadowRowValue>();
      const outcome = yield* Deferred.make<ShadowRowValue>();
      const rows: ShadowRowValue[] = [];

      const shadow = shadowReader({
        append: (_reader, row) =>
          Effect.gen(function* collect() {
            rows.push(row);
            yield* Deferred.succeed(row.type === "score" ? done : outcome, row);
          }),
        classify: () => Deferred.await(permit).pipe(Effect.as(success)),
        envEnabled: true,
        reader: () => "fleet/desk",
      });

      const time = yield* Clock.currentTimeMillis;
      shadow.observe(mail("woke"), "Now", time);
      shadow.offer(message("woke"));
      shadow.startTurn();

      if (response === "send") {
        shadow.send();
      }

      const tool = { content: [{ type: "toolCall" }], role: "assistant" };

      const ack = {
        content: [{ text: "ok", type: "text" }],
        role: "assistant",
      };

      const messages = [message("unrelated")];

      if (response !== "not-shown") {
        messages.push(message("woke"));
      }

      shadow.endTurn([
        ...messages,
        ...[tool].filter(() => response === "tool"),
        ...[ack].filter(() => response === "text"),
      ]);

      if (response !== "not-shown") {
        expect(yield* Deferred.await(outcome)).toMatchObject({
          id: "woke",
          type: "outcome",
        });
      }

      yield* Deferred.succeed(permit, true);
      yield* Deferred.await(done);
      const asOf = yield* Clock.currentTimeMillis;
      const result = shadowReport(rows, asOf);

      const expected = {
        empty: "none",
        "not-shown": "none",
        send: "acted",
        text: "ack",
        tool: "acted",
      } as const;

      expect(result.all.confusion.byOutcome[expected[response]].now).toBe(1);
    }),
  { arbitrary: { runs: 15 } }
);

it.prop(
  "Jev threshold edges are inclusive, and the now threshold wins overlap",
  [Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 0 }))],
  ([bp]) => {
    expect(mappedRoute(bp / 10_000, bp, bp)).toBe("now");

    if (bp < 10_000) {
      expect(mappedRoute(bp / 10_000, bp + 1, bp)).toBe("later");
    }

    if (bp > 0) {
      expect(mappedRoute((bp - 1) / 10_000, bp, bp)).toBe("quiet");
    }
  }
);
