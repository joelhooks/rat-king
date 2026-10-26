import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  admissionKeyIdentity,
  messageKeyIdentity,
} from "../../../stacks/nest/restore-drill-mailbox-projection.ts";
import { sealed, recipientDid } from "../../envelope/test/helpers.ts";
import { MessageEvent } from "../../lexicon/src/defs.ts";
import { Output } from "../../lexicon/src/mailbox.list.ts";

it.effect.prop(
  "replayed admissions and lifecycle receipts preserve one distinct receipt key, including delegated copy identity",
  {
    delegated: Arbitrary.schema(Schema.Boolean),
    repeats: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 1 }))
    ),
    states: Arbitrary.schema(
      Schema.Array(Schema.Literals(["delivered", "acked", "expired"])).check(
        Schema.isMaxLength(15)
      )
    ),
  },
  ({ states, repeats, delegated }) =>
    Effect.gen(function* wireCounts() {
      const sample = yield* sealed();

      const copyId =
        sample.envelope.aad.messageId === "3mxcx45mn7sex"
          ? "3mxcx45mn7sey"
          : "3mxcx45mn7sex";

      const receipt = {
        message: {
          messageId: delegated ? copyId : sample.envelope.aad.messageId,
          senderDid: sample.envelope.aad.senderDid,
        },
        recipientDid,
        seq: 1,
        state: "accepted",
      };

      const events = [
        ...Array.from({ length: repeats }, (_, index) => ({
          $type: "sh.mschf.ratking.defs#messageEvent",
          envelope: sample.envelope,
          receipt: { ...receipt, seq: index + 1 },
          seq: index + 1,
        })),
        ...states.map((state, index) => ({
          $type: "sh.mschf.ratking.defs#receiptEvent",
          receipt: { ...receipt, seq: index + repeats + 1, state },
          seq: index + repeats + 1,
        })),
      ];

      const page = yield* Schema.decodeUnknownEffect(Schema.toType(Output))({
        events,
        throughSeq: events.length,
      });

      const encoded = yield* Schema.encodeEffect(Output)(page);
      const decoded = yield* Schema.decodeEffect(Output)(encoded);

      expect(decoded.events).toHaveLength(states.length + repeats);
      const admissions = decoded.events.filter(Schema.is(MessageEvent));
      expect(admissions).toHaveLength(repeats);

      const keys = new Set(
        admissions.map((event) => admissionKeyIdentity(event.receipt))
      );

      expect([...keys]).toEqual([
        messageKeyIdentity({
          messageId: receipt.message.messageId,
          recipientDid,
          senderDid: receipt.message.senderDid,
        }),
      ]);

      if (delegated) {
        expect(receipt.message.messageId).not.toBe(
          sample.envelope.aad.messageId
        );
      }

      expect(
        decoded.events.filter(
          (event) => event.$type === "sh.mschf.ratking.defs#messageEvent"
        )
      ).toHaveLength(repeats);
    })
);
