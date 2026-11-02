import { it } from "@effect/vitest";
import { Arbitrary, Effect, Option, Schema } from "effect";
import { expect } from "vitest";

import { attend } from "../src/attend.ts";
import type { ThreadForward } from "../src/thread-routing.ts";
import { projectThread } from "../src/thread-routing.ts";
import { replyRecipients, Threads, threadsLayer } from "../src/threads.ts";
import { inbound, Mode, ownershipModel, Step } from "./thread-routing-model.ts";

it.effect.prop(
  "ownership model: every subscriber gets every opted-in event; failures, new threads, direct names and operator mail wake the router; controls and restart preserve ownership",
  [
    Arbitrary.schema(Mode),
    Arbitrary.schema(Schema.Array(Step).check(Schema.isMaxLength(60))),
  ],
  ([mode, steps]) => ownershipModel(mode, steps)
);

const Projection = Schema.Struct({
  encrypted: Schema.Boolean,
  sealed: Schema.Boolean,
  trusted: Schema.Boolean,
  verified: Schema.Boolean,
});

it.effect.prop(
  "only signed configured routers project a forward; sealed mail cannot project from plaintext, and replies retain the original sender, id and conversation root",
  [Arbitrary.schema(Projection)],
  ([sample]) =>
    Effect.gen(function* projection() {
      const original = inbound("root-a", "original");

      const record: typeof ThreadForward.Type = {
        $type: "sh.mschf.ratking.thread#message",
        original: {
          $type: "sh.mschf.ratking.relay#message",
          body: original.body,
          cc: false,
          did: original.did,
          encrypted: sample.encrypted,
          from: original.from,
          id: original.id,
          kind: "ask",
          label: null,
          replyTo: "parent",
          summary: null,
          to: "router",
          verified: true,
        },
        reply: { parent: "parent", root: "root-a" },
        thread: "root-a",
      };

      const projected = projectThread(
        sample.trusted ? [{ name: "router" }] : [],
        "owner",
        {
          did: "did:web:router.example.invalid",
          encrypted: sample.sealed,
          from: "router",
          id: "forward-envelope",
          record,
          replyTo: Option.none(),
          verified: sample.verified,
        }
      );

      const allowed =
        sample.trusted &&
        sample.verified &&
        (!sample.encrypted || sample.sealed);

      expect(Option.isSome(projected)).toBe(allowed);

      if (Option.isNone(projected)) {
        return;
      }

      const threads = yield* Threads;
      yield* threads.remember(projected.value);
      const received = yield* threads.lookup(original.id);

      expect(Option.isSome(received)).toBe(true);

      if (Option.isSome(received)) {
        expect(received.value.id).toBe(original.id);
        expect(received.value.did).toBe(original.did);
        expect(received.value.thread).toBe("root-a");
        expect(received.value.reply).toEqual(record.reply);
        expect(received.value.threadRouter?.encrypted).toBe(sample.encrypted);
        expect(replyRecipients(received.value, "owner")).toEqual(["sender"]);
      }

      expect(
        attend(projected.value, {}, 0, undefined, Option.none())._tag
      ).toBe("Now");
    }).pipe(Effect.provide(threadsLayer))
);
