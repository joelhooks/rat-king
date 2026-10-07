import { it } from "@effect/vitest";
import { Arbitrary, Effect, Result, Schema } from "effect";
import { expect } from "vitest";

import {
  identity,
  document,
} from "../../../packages/mailbox-client/test/identity.ts";
import { lookupPeerDocument } from "../src/documents.ts";

it.effect.prop(
  "public directory gates caller and peer and never returns document extensions",
  [Arbitrary.schema(Schema.Boolean)],
  ([allowed]) =>
    Effect.gen(function* directoryProof() {
      const own = yield* identity("did:web:desk.invalid");
      const peer = yield* document(yield* identity("did:web:phone.invalid"));
      let lookups = 0;

      const input = {
        allowlist: allowed ? [own.did, peer.id] : [peer.id],
        configured: [],
        registered: () =>
          Effect.sync(() => {
            lookups += 1;

            return JSON.stringify({
              ...peer,
              privateHost: "private.invalid",
              service: [{ endpoint: "https://private.invalid" }],
            });
          }),
      };

      const result = yield* lookupPeerDocument(input, own.did, peer.id).pipe(
        Effect.result
      );

      expect(Result.isSuccess(result)).toBe(allowed);
      expect(lookups).toBe(allowed ? 1 : 0);

      if (Result.isSuccess(result)) {
        expect(result.success).toEqual(peer);
      }

      const refused = yield* lookupPeerDocument(
        input,
        peer.id,
        "did:web:unknown.invalid"
      ).pipe(Effect.result);

      expect(Result.isFailure(refused)).toBe(true);
      expect(lookups).toBe(allowed ? 1 : 0);
    })
);
