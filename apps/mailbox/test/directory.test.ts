import { it } from "@effect/vitest";
import { Arbitrary, Effect, Result, Schema } from "effect";
import { expect } from "vitest";

import {
  identity,
  document,
} from "../../../packages/mailbox-client/test/identity.ts";
import { lookupPeerDocument } from "../src/documents.ts";

it.effect.prop(
  "any authenticated caller reads a registered peer document, never its extensions",
  [Arbitrary.schema(Schema.Boolean)],
  ([registered]) =>
    Effect.gen(function* directoryProof() {
      const own = yield* identity("did:web:desk.invalid");
      const peer = yield* document(yield* identity("did:web:phone.invalid"));
      let lookups = 0;

      const input = {
        configured: [],
        registered: () =>
          Effect.sync(() => {
            lookups += 1;

            return registered
              ? JSON.stringify({
                  ...peer,
                  privateHost: "private.invalid",
                  service: [{ endpoint: "https://private.invalid" }],
                })
              : undefined;
          }),
      };

      const result = yield* lookupPeerDocument(input, own.did, peer.id).pipe(
        Effect.result
      );

      expect(Result.isSuccess(result)).toBe(registered);
      expect(lookups).toBe(1);

      if (Result.isSuccess(result)) {
        expect(result.success).toEqual(peer);
      }

      const refused = yield* lookupPeerDocument(
        input,
        own.did,
        "did:plc:unknown"
      ).pipe(Effect.result);

      expect(Result.isFailure(refused)).toBe(true);
      expect(lookups).toBe(1);
    })
);
