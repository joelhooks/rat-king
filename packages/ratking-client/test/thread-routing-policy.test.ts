import { it } from "@effect/vitest";
import { Arbitrary, Effect, Logger, Option, Schema } from "effect";
import { expect } from "vitest";

import { attend } from "../src/attend.ts";
import type { ThreadRoutingValue } from "../src/config.ts";
import type { Inbound, InboundRecord } from "../src/payload.ts";
import { openThreadRouting } from "../src/thread-routing.ts";
import type { ThreadEntry } from "../src/thread-routing.ts";
import { inbound } from "./thread-routing-model.ts";

const Direct = Schema.Struct({
  encrypted: Schema.Boolean,
  kind: Schema.Literals(["quiet", "cc", "delegated", "noReply", "data"]),
  redelivered: Schema.Boolean,
  settled: Schema.Boolean,
});

it.effect.prop(
  "F2: non-pass-through mail keeps its own quiet, cc, delegation, notice and data attention on the fallback path",
  [Arbitrary.schema(Direct)],
  ([sample]) =>
    Effect.gen(function* directAttention() {
      const message: Inbound = { ...inbound("root-a", "root-a") };

      if (sample.kind === "quiet") {
        Object.assign(message, { digestMinutes: 5, quiet: true });
      }

      if (sample.kind === "cc") {
        Object.assign(message, { cc: true, copy: true });
      }

      if (sample.kind === "delegated") {
        Object.assign(message, { delegatedTo: "elsewhere" });
      }

      if (sample.kind === "noReply") {
        Object.assign(message, { noReply: true });
      }

      if (sample.kind === "data") {
        Object.assign(message, { kind: "data" });
      }

      const local: Inbound[] = [];
      const fallback: Inbound[] = [];

      const router = yield* openThreadRouting(
        { name: "router", senders: ["sender"] },
        {
          deliver: (received) =>
            Effect.sync(() => {
              local.push(received);
            }),
          fallback: (received, settled, encrypted, redelivered) =>
            Effect.sync(() => {
              expect({ encrypted, redelivered, settled }).toEqual({
                encrypted: sample.encrypted,
                redelivered: sample.redelivered,
                settled: sample.settled,
              });
              fallback.push(received);
            }),
          forward: () => Effect.die("Direct mail must not be forwarded"),
          load: Effect.succeed([]),
          save: () => Effect.void,
        }
      );

      yield* router.receive(
        message,
        sample.settled,
        sample.encrypted,
        sample.redelivered
      );
      expect(local).toEqual([]);
      expect(fallback).toEqual([message]);
      expect(
        attend(fallback[0] ?? message, {}, 0, undefined, Option.none())
      ).toEqual(attend(message, {}, 0, undefined, Option.none()));
    })
);

const Claim = Schema.Struct({
  gate: Schema.Literals(["absent", "exact", "prefix", "other", "empty"]),
  owner: Schema.Literals(["project/alpha", "project-beta/alpha", "other"]),
});

it.effect.prop(
  "F3: exact and namespace owner allowlists fence claims; omitted allowlists retain permissive behavior and every accepted claim is logged",
  [Arbitrary.schema(Claim)],
  ([sample]) =>
    Effect.gen(function* claimPolicy() {
      const config: ThreadRoutingValue = {
        name: "router",
        senders: ["sender"],
      };

      if (sample.gate !== "absent") {
        const patterns = {
          empty: [],
          exact: [sample.owner],
          other: ["different/"],
          prefix: ["project/"],
        };

        Object.assign(config, { owners: patterns[sample.gate] });
      }

      const logs: string[] = [];

      const capture = Logger.layer([
        Logger.make(({ message }) => {
          logs.push(String(message));
        }),
      ]);

      let journal: readonly ThreadEntry[] = [];
      let forwards = 0;

      yield* Effect.gen(function* enforceClaims() {
        const router = yield* openThreadRouting(config, {
          deliver: () => Effect.void,
          fallback: () => Effect.void,
          forward: () =>
            Effect.sync(() => {
              forwards += 1;
            }),
          load: Effect.succeed([]),
          save: (entries) =>
            Effect.sync(() => {
              journal = entries;
            }),
        });

        const control: InboundRecord = {
          did: `did:web:${sample.owner.replaceAll("/", "-")}.example.invalid`,
          from: sample.owner,
          id: "claim-one",
          record: {
            $type: "sh.mschf.ratking.thread#control",
            op: "claim",
            thread: "root-a",
          },
          replyTo: Option.none(),
          verified: true,
        };

        const allowed =
          sample.gate === "absent" ||
          sample.gate === "exact" ||
          (sample.gate === "prefix" && sample.owner.startsWith("project/"));

        expect(yield* router.control(control)).toBe(allowed);
        expect(yield* router.control({ ...control, id: "claim-two" })).toBe(
          allowed
        );
        yield* router.receive(inbound("root-a"), false, true);
        expect(forwards).toBe(allowed ? 1 : 0);
        expect(journal[0]?.owners.map((entry) => entry.name) ?? []).toEqual(
          allowed ? [sample.owner] : []
        );
        expect(
          logs.filter((message) => message.includes("Thread claimed"))
        ).toHaveLength(allowed ? 2 : 0);
        expect(
          logs.filter((message) => message.includes("Thread claim refused"))
        ).toHaveLength(allowed ? 0 : 2);
      }).pipe(Effect.provide(capture));
    })
);
