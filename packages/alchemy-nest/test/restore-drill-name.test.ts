import { it } from "@effect/vitest";
import { Arbitrary, Effect, Result, Schema } from "effect";
import { expect } from "vitest";

import { requireIssuerName } from "../../../stacks/nest/restore-drill-proof-assertion.ts";

it.effect.prop(
  "found issuer names return their exact DID; absent names fail instead of inventing a template DID",
  {
    did: Arbitrary.schema(
      Schema.Literals([
        "did:web:example.com:ordinary-agent",
        "did:web:example.net:different-agent",
      ])
    ),
    found: Arbitrary.schema(Schema.Boolean),
  },
  ({ did, found }) =>
    Effect.gen(function* issuerNameProof() {
      const result = yield* requireIssuerName(found ? { did } : undefined).pipe(
        Effect.result
      );

      expect(Result.isSuccess(result)).toBe(found);

      if (Result.isFailure(result)) {
        expect(result.failure.assertionCode).toBe("PROOF_NAME_NOT_IN_ISSUER");
      } else {
        expect(result.success).toBe(did);
      }
    })
);
