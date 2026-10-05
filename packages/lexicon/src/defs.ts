import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export const Aad = Schema.StructWithRest(
  Schema.Struct({
    expiresAt: Schema.optionalKey(
      Runtime.lexString({
        description: "Absent means no expiry; never infer expiry from the TID.",
        format: "datetime",
        type: "string",
      }).pipe(Schema.brand("Lexicon:datetime"))
    ),
    messageId: Runtime.lexString({
      description: "Sender DID plus TID is the immutable idempotency key.",
      format: "tid",
      type: "string",
    }).pipe(Schema.brand("Lexicon:tid")),
    recipientDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    recipientKeyId: Runtime.lexString({
      description:
        "DID URL of recipient's keyAgreement key; checked against recipientDid.",
      format: "uri",
      type: "string",
    }).pipe(Schema.brand("Lexicon:uri")),
    senderDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type AadValue = typeof Aad.Type;

export const AppSignature = Schema.StructWithRest(
  Schema.Struct({
    algorithm: Runtime.lexString({
      knownValues: ["ES256", "ES256K"],
      type: "string",
    }),
    keyId: Runtime.lexString({
      description: "DID URL of sender's authorized signing key at send time.",
      format: "uri",
      type: "string",
    }).pipe(Schema.brand("Lexicon:uri")),
    publicKeyMultibase: Schema.optionalKey(
      Runtime.lexString({
        description:
          "Optional historical key hint, never authority without verified key history.",
        type: "string",
      })
    ),
    signature: Runtime.Bytes.check(
      Schema.makeFilter(
        (value) => value.length >= 0 && value.length <= 9_007_199_254_740_991,
        { expected: "byte length constraints" }
      )
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type AppSignatureValue = typeof AppSignature.Type;

export const BirthContext = Schema.StructWithRest(
  Schema.Struct({
    createdAt: Schema.optionalKey(
      Runtime.lexString({ format: "datetime", type: "string" }).pipe(
        Schema.brand("Lexicon:datetime")
      )
    ),
    operator: Runtime.lexString({
      description:
        "Public operator namespace label, not a private person name.",
      type: "string",
    }),
    project: Runtime.lexString({
      description:
        "Public project namespace at birth, not the current assignment.",
      type: "string",
    }),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type BirthContextValue = typeof BirthContext.Type;

export const DeliveryState = Runtime.lexString({
  description:
    "Open values: accepted = durable admission; queued = awaiting runtime; delivered = injected into leased runtime, not processed; acked = recipient acknowledgment; expired = sender-set expiry reached; failed = terminal failure with a receipt. Unknown values are not success.",
  knownValues: [
    "accepted",
    "queued",
    "delivered",
    "acked",
    "expired",
    "failed",
  ],
  type: "string",
});

export type DeliveryStateValue = typeof DeliveryState.Type;

export const DeliveryStateKnownValues = [
  "accepted",
  "queued",
  "delivered",
  "acked",
  "expired",
  "failed",
] as const;

export type DeliveryStateKnown = (typeof DeliveryStateKnownValues)[number];

export const isDeliveryStateKnown = (
  value: DeliveryStateValue
): value is DeliveryStateKnown =>
  DeliveryStateKnownValues.some((known) => known === value);

export const HpkeSuite = Schema.StructWithRest(
  Schema.Struct({
    aeadId: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(65_535)
    ),
    kdfId: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(65_535)
    ),
    kemId: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(65_535)
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type HpkeSuiteValue = typeof HpkeSuite.Type;

export const EncryptedEnvelope = Schema.StructWithRest(
  Schema.Struct({
    aad: Aad,
    ciphertext: Runtime.Bytes.check(
      Schema.makeFilter(
        (value) => value.length >= 1 && value.length <= 9_007_199_254_740_991,
        { expected: "byte length constraints" }
      )
    ),
    enc: Runtime.Bytes.check(
      Schema.makeFilter(
        (value) => value.length >= 1 && value.length <= 9_007_199_254_740_991,
        { expected: "byte length constraints" }
      )
    ),
    suite: HpkeSuite,
    version: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type EncryptedEnvelopeValue = typeof EncryptedEnvelope.Type;

export const MessageRef = Schema.StructWithRest(
  Schema.Struct({
    cid: Schema.optionalKey(
      Runtime.lexString({
        description:
          "Optional CID of that exact persisted record, not a hash of JSON.",
        format: "cid",
        type: "string",
      }).pipe(Schema.brand("Lexicon:cid"))
    ),
    messageId: Runtime.lexString({ format: "tid", type: "string" }).pipe(
      Schema.brand("Lexicon:tid")
    ),
    senderDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    uri: Schema.optionalKey(
      Runtime.lexString({
        description:
          "Optional actual persisted record URI; never fabricate a phase-0 record locator.",
        format: "at-uri",
        type: "string",
      }).pipe(Schema.brand("Lexicon:at-uri"))
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type MessageRefValue = typeof MessageRef.Type;

export const Receipt = Schema.StructWithRest(
  Schema.Struct({
    detail: Schema.optionalKey(
      Runtime.lexString({
        description: "Optional public-safe failure or expiry explanation.",
        type: "string",
      })
    ),
    message: MessageRef,
    recipientDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    recordedAt: Schema.optionalKey(
      Runtime.lexString({ format: "datetime", type: "string" }).pipe(
        Schema.brand("Lexicon:datetime")
      )
    ),
    seq: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    state: DeliveryState,
    wakeReason: Schema.optionalKey(Runtime.lexString({ type: "string" })),
    woke: Schema.optionalKey(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ReceiptValue = typeof Receipt.Type;

export const MessageEvent = Schema.StructWithRest(
  Schema.Struct({
    envelope: EncryptedEnvelope,
    receipt: Receipt,
    seq: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type MessageEventValue = typeof MessageEvent.Type;

export const ReceiptEvent = Schema.StructWithRest(
  Schema.Struct({
    receipt: Receipt,
    seq: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ReceiptEventValue = typeof ReceiptEvent.Type;

export const SignedMessage = Schema.StructWithRest(
  Schema.Struct({
    appSignature: AppSignature,
    canonicalSigningBytes: Runtime.Bytes.check(
      Schema.makeFilter(
        (value) => value.length >= 0 && value.length <= 9_007_199_254_740_991,
        { expected: "byte length constraints" }
      )
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type SignedMessageValue = typeof SignedMessage.Type;

export const SigningPayload = Schema.StructWithRest(
  Schema.Struct({
    aad: Aad,
    body: Runtime.Bytes.check(
      Schema.makeFilter(
        (value) => value.length >= 0 && value.length <= 9_007_199_254_740_991,
        { expected: "byte length constraints" }
      )
    ),
    createdAt: Schema.optionalKey(
      Runtime.lexString({ format: "datetime", type: "string" }).pipe(
        Schema.brand("Lexicon:datetime")
      )
    ),
    replyTo: Schema.optionalKey(MessageRef),
    suite: HpkeSuite,
    version: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type SigningPayloadValue = typeof SigningPayload.Type;
