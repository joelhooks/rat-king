import { it } from "@effect/vitest";
import { Arbitrary, Data, Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  ProofAssertionFailure,
  proofFailureMetadata,
} from "../../../stacks/nest/restore-drill-proof-errors.ts";
import { MailboxClientError } from "../src/error.ts";
import { SendOutcomes } from "../src/prepare.ts";

it.effect.prop(
  "real Effect failure, defect, rejected outcome and interruption retain distinct structured codes without private reasons",
  {
    branch: Arbitrary.schema(
      Schema.Literals(["fail", "die", "rejected", "interrupt"])
    ),
    nonce: Arbitrary.schema(Schema.Int),
  },
  ({ branch, nonce }) =>
    Effect.gen(function* realCauses() {
      const sensitive = `PRIVATE_CAUSE_${nonce}`;

      const faults: Record<
        typeof branch,
        Effect.Effect<
          never,
          ProofAssertionFailure | ReturnType<typeof SendOutcomes.Rejected>
        >
      > = {
        die: Effect.die(new Error(sensitive)),
        fail: Effect.fail(
          new ProofAssertionFailure({ assertionCode: "MESSAGE_COUNT_MISMATCH" })
        ),
        interrupt: Effect.interrupt,
        rejected: Effect.fail(
          SendOutcomes.Rejected({
            error: new MailboxClientError({
              error: "NameNotFound",
              reason: sensitive,
              status: 404,
            }),
          })
        ),
      };

      const expected = {
        die: { causeKind: "Die", code: "EFFECT_DIE" },
        fail: {
          assertionCode: "MESSAGE_COUNT_MISMATCH",
          causeKind: "Fail",
          code: "EFFECT_FAIL",
          tag: "ProofAssertionFailure",
        },
        interrupt: { causeKind: "Interrupt", code: "EFFECT_INTERRUPT" },
        rejected: {
          causeKind: "Fail",
          code: "XRPC_REJECTED",
          status: 404,
          tag: "MailboxClientError",
          xrpcError: "NameNotFound",
        },
      };

      const actual = yield* faults[branch].pipe(
        Effect.matchCause({
          onFailure: (cause) =>
            proofFailureMetadata("primary", cause, {
              lastOk: "reload",
              step: "resolve-name",
            }),
          onSuccess: () => proofFailureMetadata("primary", null),
        })
      );

      expect(actual).toMatchObject({
        ...expected[branch],
        lastOk: "reload",
        phase: "primary",
        step: "resolve-name",
      });
      expect(JSON.stringify(actual)).not.toContain(sensitive);
    })
);

it.prop(
  "messages cannot spoof structured protocol status or leak reasons, unknown tags or unknown error codes",
  {
    nonce: Arbitrary.schema(Schema.Int),
  },
  ({ nonce }) => {
    const privateText = `PRIVATE_FIELD_${nonce}`;

    const fakeMessage = proofFailureMetadata(
      "primary",
      new Error("Scratch HTTP 500")
    );

    const foreignError = Data.taggedEnum<{
      readonly _tag: "ForeignFault";
      readonly error: string;
      readonly reason: string;
      readonly status: number;
    }>().ForeignFault({ error: privateText, reason: privateText, status: 403 });

    const structured = proofFailureMetadata(
      "primary",
      Data.taggedEnum<{
        readonly _tag: "Rejected";
        readonly error: typeof foreignError;
      }>().Rejected({ error: foreignError })
    );

    expect(fakeMessage.status).toBeUndefined();
    expect(structured).toMatchObject({ code: "XRPC_REJECTED", status: 403 });
    expect(structured.tag).toBeUndefined();
    expect(structured.xrpcError).toBeUndefined();
    expect(JSON.stringify(structured)).not.toContain(privateText);
  }
);
