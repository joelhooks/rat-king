import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  recipientDid,
  sealed,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import { pendingPush, registerDevice } from "../src/device.ts";
import { MailboxStore } from "../src/store.ts";
import { testStore } from "./helpers.ts";

const operator = "did:web:operator.invalid";

const encodedRegistration = (token: string, environment: string) =>
  JSON.stringify({ did: recipientDid, environment, token });

it.effect.prop(
  "only the owner can register or replace a device, and only the operator can read a pending push for an absent reader",
  {
    environment: Schema.Literals(["production", "sandbox"]),
    live: Schema.Boolean,
    tokenByte: Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })),
  },
  ({ environment, live, tokenByte }) =>
    Effect.gen(function* proof() {
      const sample = yield* sealed();
      const storage = yield* testStore;
      const store = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      const now = 1_800_000_000_000;
      const token = tokenByte.toString(16).padStart(2, "0").repeat(32);

      const register = (issuer: string, value: string) =>
        registerDevice(storage.sql, recipientDid, issuer, value);

      const input = encodedRegistration(token, environment);

      yield* TestClock.setTime(now);

      expect((yield* register(operator, input).pipe(Effect.flip)).error).toBe(
        "Forbidden"
      );
      expect(
        (yield* register(
          recipientDid,
          encodedRegistration("not-hex", environment)
        ).pipe(Effect.flip)).error
      ).toBe("InvalidRequest");
      yield* register(
        recipientDid,
        encodedRegistration(
          "11",
          environment === "sandbox" ? "production" : "sandbox"
        )
      );
      expect(yield* register(recipientDid, input)).toEqual({
        registered: true,
      });

      const receipt = yield* Schema.decodeUnknownEffect(Defs.Receipt)({
        message: { messageId: sample.envelope.aad.messageId, senderDid },
        recipientDid,
        seq: 1,
        state: "accepted",
        woke: true,
      });

      yield* store.transaction((tx) => {
        tx.put({
          admission: receipt,
          canonicalBytes: "fixture",
          current: receipt,
          envelope: sample.envelope,
        });
        tx.setLease({
          expiresAt: now + (live ? 1 : -1),
          generation: 1,
          leaseId: "fixture-lease",
        });
      });

      const read = (issuer: string) =>
        pendingPush(storage.sql, issuer, [operator]);

      expect((yield* read(recipientDid).pipe(Effect.flip)).error).toBe(
        "Forbidden"
      );
      expect(yield* read(operator)).toEqual(
        live
          ? {}
          : {
              notice: {
                admissionSeq: 1,
                body: "New sealed message",
                environment,
                messageId: sample.envelope.aad.messageId,
                title: "Rat King",
                token,
              },
            }
      );
    }).pipe(Effect.scoped)
);
