// @effect-diagnostics asyncFunction:off -- Pi callbacks are the Promise boundary.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import type { Deliver } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vitest";

import { ratkingExtension } from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import { DIGEST_MESSAGE, inbox, shownIds } from "../src/pending.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

const idle = async () => {};

const nothing = () => {};

const ignoreShown = (_id: string) => {};

const ignoreDelivery: Deliver = () => Effect.void;

const arrival = (index: number, quiet: boolean): Inbound => ({
  body: `Body ${index}`,
  cc: quiet && index % 2 === 0,
  copy: quiet && index % 2 === 0,
  did: "did:web:sender.example.invalid",
  from: "sender",
  id: `3trigger${index}`,
  kind: "message",
  label: Option.none(),
  quiet: quiet && index % 2 === 1,
  replyTo: Option.none(),
  summary: Option.some(`Summary ${index}`),
  verified: true,
});

type CustomMessage = Parameters<PiHost["sendMessage"]>[0];

const Sample = Schema.Struct({
  busy: Schema.Boolean,
  count: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 2 })),
});

it.effect.prop(
  "only direct mail can trigger a run; the next start hook brings quiet copies along without a trigger and acks them on display",
  [Arbitrary.schema(Sample)],
  ([sample]) =>
    Effect.gen(function* mailTriggeredRun() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();

      const acked = yield* Effect.all(
        Array.from({ length: sample.count }, () => Deferred.make<boolean>())
      );

      const acknowledgments = Array.from({ length: sample.count }, () => 0);
      const queued: CustomMessage[] = [];

      const submissions: {
        readonly message: CustomMessage;
        readonly trigger: boolean | undefined;
      }[] = [];

      let beforeCalls = 0;
      let before = nothing;
      let start: (facts: SessionStart) => Promise<void> = idle;
      let end: () => Promise<void> = idle;
      let shown = ignoreShown;
      let deliver = ignoreDelivery;

      const pi: PiHost = {
        events: { emit: nothing, on: () => nothing },
        onBeforeAgentStart: (handler) => {
          before = () => {
            beforeCalls += 1;
            handler();
          };
        },
        onMessageShown: (handler) => {
          shown = handler;
        },
        onSessionEnd: (handler) => {
          end = handler;
        },
        onSessionStart: (handler) => {
          start = handler;
        },
        registerMessageRenderer: nothing,
        registerTool: nothing,
        sendMessage: (message, options) => {
          submissions.push({ message, trigger: options?.triggerTurn });

          if (options?.deliverAs === "nextTurn") {
            queued.push(message);
          }
        },
      };

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: (session) =>
            Effect.succeed({
              alive: () => true,
              env: Option.none(),
              pane: Option.none(),
              pid: 1,
              session,
            }),
          layer: Layer.merge(
            harness(
              state,
              HttpClient.make(() => Effect.die("Unexpected request"))
            ),
            Layer.mock(RatKing, {
              run: (_facts, handler) =>
                Effect.sync(() => {
                  deliver = handler;
                }),
            })
          ),
          tool: Effect.succeed("ratking"),
        })(pi);
        await startSession(start, {
          isIdle: () => !sample.busy,
          session: "mail-trigger",
          warn: nothing,
        });
      });
      yield* Effect.addFinalizer(() => Effect.promise(end));

      for (let index = 0; index < sample.count; index += 1) {
        const gate = acked[index];

        if (gate === undefined) {
          throw new Error("Missing ack gate");
        }

        yield* deliver(
          arrival(index, true),
          false,
          Effect.sync(() => {
            acknowledgments[index] = (acknowledgments[index] ?? 0) + 1;
          }).pipe(Effect.andThen(Deferred.succeed(gate, true)), Effect.asVoid)
        );
      }

      expect(submissions).toHaveLength(0);
      yield* deliver(arrival(sample.count, false), false);
      expect(beforeCalls).toBe(0);
      expect(queued).toHaveLength(0);
      expect(acknowledgments).toEqual(
        Array.from({ length: sample.count }, () => 0)
      );
      const [direct] = submissions;
      expect(submissions).toHaveLength(1);
      expect(direct?.trigger).toBe(true);
      before();
      expect(beforeCalls).toBe(1);
      const [, held] = submissions;

      expect(submissions).toHaveLength(2);
      expect(held?.message.customType).toBe(DIGEST_MESSAGE);
      expect(held?.trigger).toBe(false);

      const ids = Array.from(
        { length: sample.count },
        (_value, index) => arrival(index, true).id
      );

      expect(queued).toHaveLength(1);
      const [digest] = queued;
      expect(shownIds({ ...digest, role: "custom" })).toEqual(ids);
      expect(digest?.content).toContain("🐀 while you were away");

      for (const id of ids) {
        expect(digest?.content).toEqual(expect.stringContaining(id));
      }

      shown("not-in-the-digest");
      shown(ids[0] ?? "missing");
      const [first] = acked;

      if (first === undefined) {
        throw new Error("Missing first gate");
      }

      yield* Deferred.await(first);
      expect(acknowledgments).toEqual(
        Array.from({ length: sample.count }, (_value, index) =>
          index === 0 ? 1 : 0
        )
      );

      for (const id of ids) {
        shown(id);
        shown(id);
      }

      yield* Effect.all(acked.map((gate) => Deferred.await(gate)));
      expect(acknowledgments).toEqual(
        Array.from({ length: sample.count }, () => 1)
      );
      yield* deliver(arrival(sample.count + 1, false), false);
      expect(submissions).toHaveLength(3);
      before();
      expect(beforeCalls).toBe(2);
      expect(submissions).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.prop(
  "synchronous display clears submission custody even when the same ids are redelivered after an acknowledgment retry",
  [
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 1 }))
    ),
  ],
  ([count]) => {
    let emitted = 0;

    const box: ReturnType<typeof inbox> = inbox({
      digest: (mails) => {
        emitted += 1;

        for (const mail of mails) {
          box.shown(mail.id);
        }
      },
      show: (mail) => {
        emitted += 1;
        box.shown(mail.id);
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (let index = 0; index < count; index += 1) {
        const id = `retry-${index}`;
        box.take(
          { coalesce: true, content: id, details: { id }, id },
          "nextTurn"
        );
      }

      box.flushNext({ deliverAs: "followUp", triggerTurn: false });
      expect(emitted).toBe(attempt + 1);
    }
  }
);
