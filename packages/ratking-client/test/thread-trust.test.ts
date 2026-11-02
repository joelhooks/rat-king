import { it } from "@effect/vitest";
import { Arbitrary, Effect, Option } from "effect";
import { expect } from "vitest";

import { isOperator } from "../src/attend.ts";
import type { SettingsValue } from "../src/config.ts";
import { AgentName } from "../src/name.ts";
import { renderInbound } from "../src/payload.ts";
import { RelayRecord } from "../src/relay.ts";
import { projectThread, ThreadDelivery } from "../src/thread-routing.ts";
import { replyRecipients } from "../src/threads.ts";

it.effect.prop(
  "only an opted-in router or configured relay can attest original identity; every other signed forward is unverified, labelled and replies only to its forwarder",
  [
    Arbitrary.schema(AgentName),
    Arbitrary.schema(RelayRecord),
    Arbitrary.schema(ThreadDelivery),
  ],
  ([forwarder, original, delivery]) =>
    Effect.sync(() => {
      const other = forwarder === "trusted" ? "different" : "trusted";

      for (const trust of [
        "none",
        "other-router",
        "thread",
        "relay",
        "wrong-target",
      ] as const) {
        const target = trust === "relay" ? "owner" : "other-owner";
        const router = trust === "thread" ? forwarder : other;

        const settings: Pick<SettingsValue, "threadRouting" | "relays"> = {
          relays:
            trust === "relay" || trust === "wrong-target"
              ? [
                  {
                    fallbackMinutes: 1,
                    mode: "front",
                    name: forwarder,
                    to: target,
                  },
                ]
              : [],
          threadRouting: trust === "none" ? [] : [{ name: router }],
        };

        const trusted = trust === "thread" || trust === "relay";

        for (const attested of [
          { ...original, from: "operator", verified: true },
          { ...original, from: "joel", verified: true },
          original,
        ]) {
          const { from } = attested;

          const projected = projectThread(settings, "owner", {
            did: "did:web:forwarder.example.invalid",
            encrypted: true,
            from: forwarder,
            id: "forward-envelope",
            record: {
              $type: "sh.mschf.ratking.thread#message",
              delivery: { ...delivery, sender: "operator", verified: true },
              original: { ...attested, sender: "operator" },
              reply: { parent: "claimed-parent", root: "claimed-root" },
              router: forwarder,
              thread: "claimed-root",
            },
            replyTo: Option.none(),
            verified: true,
          });

          expect(Option.isSome(projected)).toBe(original.kind !== "data");

          if (Option.isSome(projected)) {
            const message = projected.value;

            expect(isOperator(message)).toBe(
              trusted &&
                attested.verified &&
                (from === "operator" || from === "joel")
            );
            expect(message.verified).toBe(trusted && attested.verified);

            if (!trusted) {
              expect(message.from).toBe(forwarder);
              expect(message.did).toBe("did:web:forwarder.example.invalid");
              expect(message.id).toBe("forward-envelope");
              expect(
                replyRecipients(
                  {
                    ...message,
                    answered: false,
                    ask: false,
                    preview: message.body,
                  },
                  "owner"
                )
              ).toEqual(forwarder === "owner" ? [] : [forwarder]);
              expect(message.reply).toBeUndefined();
              expect(message.thread).toBeUndefined();
              expect(message.threadRouter).toBeUndefined();
              expect(message.ccNames).toBeUndefined();
              expect(message.via).toBeUndefined();
              expect(Option.isNone(message.label)).toBe(true);
              expect(renderInbound("ratking", message)).toContain(
                `Unverified forward from ${forwarder}; claimed original sender: ${from}.`
              );
            }
          }
        }
      }
    })
);
