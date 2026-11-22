/* oxlint-disable typescript/promise-function-async -- fast-check model command Promise boundary. */
import { it } from "@effect/vitest";
import { renderInbound } from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { deliverRelay, RelayRecord } from "@rat-king/ratking-client/relay";
import { Effect, Option, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { inboundLines } from "../src/message-view.ts";

const Step = Schema.Struct({
  body: Schema.String,
  event: Schema.Literals(["record", "restart"]),
  from: Schema.Literals(["desk", "imposter"]),
  originalVerified: Schema.Boolean,
  own: Schema.Literals(["desk/ea", "desk", "other"]),
  sent: Schema.Boolean,
  verified: Schema.Boolean,
});

const {
  copy: _copy,
  expiresAt: _expiresAt,
  quiet: _quiet,
  ...legacyFields
} = RelayRecord.fields;

const LegacyRelay = Schema.Struct(legacyFields);

it.prop(
  "old relay readers accept new optional fields and new readers accept old records",
  [Schema.String],
  ([body]) => {
    const legacy = {
      $type: "sh.mschf.ratking.relay#message",
      body,
      cc: true,
      did: "sender",
      encrypted: false,
      from: "peer",
      id: "copy",
      kind: "message",
      label: null,
      replyTo: null,
      summary: null,
      verified: true,
    } satisfies typeof LegacyRelay.Encoded;

    const current = {
      ...legacy,
      copy: true,
      expiresAt: "2099-01-01T00:00:00Z",
      quiet: true,
    };

    expect(Schema.decodeUnknownSync(LegacyRelay)(current)).toEqual(legacy);
    expect(Schema.decodeUnknownSync(RelayRecord)(legacy)).toEqual(legacy);
  }
);

interface Model {
  deliveries: number;
  remembered: number;
}

it.effect.prop(
  "EA relay model: only verified desk mail reaches the assigned EA, as original mail with a direct reply hint and via marker, or as a desk outbound copy that is never remembered and carries no reply hint",
  [Step, Schema.Array(Step)],
  ([seed, steps]) =>
    Effect.gen(function* eaModel() {
      const context = yield* Effect.context();
      const remembered: Inbound[] = [];
      const delivered: Inbound[] = [];

      const config = {
        fallbackMinutes: 10,
        mode: "front",
        name: "desk",
        to: "desk/ea",
      } as const;

      const command = (
        step: typeof Step.Type
      ): AsyncCommand<Model, object> => ({
        check: () => true,
        run: (model) => {
          const operation = Effect.gen(function* applyRecord() {
            if (step.event === "restart") {
              remembered.length = 0;
              model.remembered = 0;

              return;
            }

            const accepted =
              step.own === "desk/ea" && step.from === "desk" && step.verified;

            const id = `original-${model.deliveries}`;

            const projected = yield* deliverRelay(
              config,
              step.own,
              {
                did: "did:web:desk.example.invalid",
                from: step.from,
                id: "relay-envelope",
                record: step.sent
                  ? {
                      $type: "sh.mschf.ratking.relay#outbound",
                      body: step.body,
                      cc: ["carol"],
                      encrypted: true,
                      id,
                      kind: "reply",
                      replyTo: "root",
                      summary: "Sent summary",
                      thread: "root",
                      to: "person",
                    }
                  : {
                      $type: "sh.mschf.ratking.relay#message",
                      body: step.body,
                      cc: false,
                      did: "did:web:person.example.invalid",
                      encrypted: true,
                      from: "person",
                      id,
                      kind: "ask",
                      label: "Yaffle",
                      replyTo: null,
                      summary: "Original summary",
                      verified: step.originalVerified,
                    },
                replyTo: Option.none(),
                verified: step.verified,
              },
              {
                deliver: (inbound, settled) =>
                  Effect.sync(() => {
                    expect(settled).toBe(false);
                    delivered.push(inbound);
                  }),
                remember: (inbound) =>
                  Effect.sync(() => {
                    remembered.push(inbound);
                  }),
              }
            );

            expect(projected).toBe(accepted);

            if (accepted && step.sent) {
              model.deliveries += 1;
              const copy = delivered.at(-1);

              if (copy === undefined) {
                throw new Error("Missing outbound copy");
              }

              expect(copy).toMatchObject({
                body: step.body,
                ccNames: ["carol"],
                from: "desk",
                id,
                sentBy: "desk",
                thread: "root",
                to: "person",
              });

              const text = renderInbound("intercom", copy);
              expect(text).toContain("sent by desk");
              expect(text).not.toContain('action: "reply"');
              expect(text).not.toContain('action: "handled"');

              const shown = [false, true].map((expanded) =>
                inboundLines({
                  expanded,
                  theme: { bold: (line) => line, fg: (_colour, line) => line },
                  tool: "intercom",
                  value: {
                    body: copy.body,
                    cc: false,
                    did: copy.did,
                    from: copy.from,
                    id: copy.id,
                    kind: copy.kind,
                    sentBy: copy.sentBy,
                    to: copy.to,
                    verified: copy.verified,
                  },
                  width: 80,
                }).join("\n")
              );

              expect(shown[0]).toContain("🐀↩ sent to person");
              expect(shown[0]).toContain("sent by desk");
              expect(shown[1]).not.toContain('action: "reply"');
            } else if (accepted) {
              model.deliveries += 1;
              model.remembered += 1;
              const original = delivered.at(-1);
              expect(original?.id).toBe(id);
              expect(original?.from).toBe("person");
              expect(original?.verified).toBe(step.originalVerified);
              expect(original?.body).toBe(step.body);
              expect(original?.label).toEqual(Option.some("Yaffle"));
              expect(original?.summary).toEqual(
                Option.some("Original summary")
              );

              if (original === undefined) {
                throw new Error("Missing original");
              }

              const text = renderInbound("intercom", original);
              expect(text).toContain(
                `To reply to person: intercom({ action: "reply", replyTo: "${id}", replyAll: false`
              );
              expect(text).toContain(`action: "handled", replyTo: "${id}"`);

              const compact = inboundLines({
                expanded: false,
                theme: { bold: (line) => line, fg: (_colour, line) => line },
                tool: "intercom",
                value: {
                  body: original.body,
                  cc: false,
                  did: original.did,
                  from: original.from,
                  id: original.id,
                  kind: original.kind,
                  label: "Yaffle",
                  relay: original.relay,
                  verified: original.verified,
                },
                width: 80,
              });

              expect(compact.join("\n")).toContain("via desk");
              expect(compact[0]).toContain("Yaffle");
              expect(compact.length).toBeLessThanOrEqual(8);
            }

            expect(delivered).toHaveLength(model.deliveries);
            expect(remembered).toHaveLength(model.remembered);
          });

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check reuses the test context.
          return Effect.runPromiseWith(context)(operation);
        },
        toString: () => JSON.stringify(step),
      });

      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({ model: { deliveries: 0, remembered: 0 }, real: {} }),
          [
            command({
              ...seed,
              event: "record",
              from: "desk",
              own: "desk/ea",
              verified: true,
            }),
            command({
              ...seed,
              event: "record",
              from: "desk",
              own: "desk/ea",
              verified: false,
            }),
            command({
              ...seed,
              event: "record",
              from: "imposter",
              own: "desk/ea",
              verified: true,
            }),
            command({
              ...seed,
              event: "record",
              from: "desk",
              own: "other",
              verified: true,
            }),
            ...steps.map(command),
          ]
        )
      );
    }),
  { arbitrary: { runs: 150 } }
);
