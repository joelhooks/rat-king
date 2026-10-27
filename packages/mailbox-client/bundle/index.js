// packages/envelope/src/envelope.ts
import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";

// packages/lexicon/src/defs.ts
import { Schema as Schema3 } from "effect";

// packages/lexicon/src/edge.pass.ts
import { Schema as Schema2 } from "effect";

// packages/lexicon/src/runtime.ts
import { isCid, parseCid, parseCidSafe } from "@atproto/lex-data";
import { Lexicons } from "@atproto/lexicon";
import { Schema, SchemaGetter } from "effect";
var Cid = Schema.declare(
  (value) => isCid(value, { flavor: "dasl" })
);
var CidText = Schema.String.check(
  Schema.makeFilter(
    (value) => parseCidSafe(value, { flavor: "dasl" }) !== null,
    { expected: "CIDv1, raw or DAG-CBOR, SHA-256" }
  )
);
var Link = Schema.StructWithRest(Schema.Struct({ $link: CidText }), [
  Schema.Record(Schema.String, Schema.String)
]).check(
  Schema.makeFilter((value) => Object.keys(value).length === 1, {
    expected: "one link wrapper key"
  })
).pipe(
  Schema.decodeTo(Cid, {
    decode: SchemaGetter.transform(
      (value) => parseCid(value.$link, { flavor: "dasl" })
    ),
    encode: SchemaGetter.transform((value) => ({ $link: value.toString() }))
  })
);
var Bytes = Schema.StructWithRest(
  Schema.Struct({ $bytes: Schema.String }),
  [Schema.Record(Schema.String, Schema.String)]
).check(
  Schema.makeFilter((value) => Object.keys(value).length === 1, {
    expected: "one byte wrapper key"
  })
).pipe(Schema.decodeTo(Schema.Struct({ $bytes: Schema.Uint8ArrayFromBase64 }))).pipe(
  Schema.decodeTo(Schema.Uint8Array, {
    decode: SchemaGetter.transform((value) => value.$bytes),
    encode: SchemaGetter.transform((value) => ({ $bytes: value }))
  })
);
var Data = Schema.suspend(
  () => Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Int,
    Schema.String,
    Bytes,
    Link,
    Schema.Array(Data),
    Schema.Record(Schema.String, Data).check(
      Schema.makeFilter(
        (value) => !("$bytes" in value) && !("$link" in value),
        { expected: "data map, not a malformed byte or link wrapper" }
      )
    )
  ])
);
var DataMap = Schema.Record(Schema.String, Data).check(
  Schema.makeFilter((value) => !("$bytes" in value) && !("$link" in value), {
    expected: "data-model map"
  })
);
var TaggedMap = Schema.StructWithRest(
  Schema.Struct({ $type: Schema.String }),
  [Schema.Record(Schema.String, Data)]
);
var lexString = (definition) => {
  const validators = new Lexicons([
    {
      defs: {
        main: {
          properties: { value: definition },
          required: ["value"],
          type: "object"
        }
      },
      id: "sh.mschf.ratking.lexgen",
      lexicon: 1
    }
  ]);
  return Schema.String.check(
    Schema.makeFilter(
      (value) => validators.validate("sh.mschf.ratking.lexgen", { value }).success,
      { expected: "Lexicon string constraints" }
    )
  );
};
var Blob = Schema.StructWithRest(
  Schema.Struct({
    $type: Schema.Literal("blob"),
    mimeType: Schema.String,
    ref: Link,
    size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  }),
  [Schema.Record(Schema.String, Data)]
);
var XrpcErrorBody = Schema.StructWithRest(
  Schema.Struct({
    error: Schema.String,
    message: Schema.optionalKey(Schema.String)
  }),
  [Schema.Record(Schema.String, Data)]
);

// packages/lexicon/src/edge.pass.ts
var Main = Schema2.StructWithRest(
  Schema2.Struct({
    $type: Schema2.Literal("sh.ratking.pass"),
    desk: lexString({ maxLength: 256, minLength: 1, type: "string" }),
    deskDid: lexString({ format: "did", type: "string" }).pipe(
      Schema2.brand("Lexicon:did")
    ),
    exp: Schema2.Int.check(
      Schema2.isGreaterThanOrEqualTo(0),
      Schema2.isLessThanOrEqualTo(9007199254740991)
    ),
    iat: Schema2.Int.check(
      Schema2.isGreaterThanOrEqualTo(0),
      Schema2.isLessThanOrEqualTo(9007199254740991)
    ),
    nonce: lexString({ maxLength: 256, minLength: 1, type: "string" }),
    run: lexString({ maxLength: 256, minLength: 1, type: "string" }),
    scope: Schema2.Array(
      lexString({ maxLength: 512, minLength: 1, type: "string" })
    ).check(Schema2.isMinLength(1), Schema2.isMaxLength(64)),
    v: Schema2.Literal(1).check(
      Schema2.isGreaterThanOrEqualTo(-9007199254740991),
      Schema2.isLessThanOrEqualTo(9007199254740991)
    ),
    worker: lexString({ format: "did", type: "string" }).pipe(
      Schema2.brand("Lexicon:did")
    )
  }),
  [Schema2.Record(Schema2.String, Data)]
);

// packages/lexicon/src/defs.ts
var Aad = Schema3.StructWithRest(
  Schema3.Struct({
    expiresAt: Schema3.optionalKey(
      lexString({
        description: "Absent means no expiry; never infer expiry from the TID.",
        format: "datetime",
        type: "string"
      }).pipe(Schema3.brand("Lexicon:datetime"))
    ),
    messageId: lexString({
      description: "Sender DID plus TID is the immutable idempotency key.",
      format: "tid",
      type: "string"
    }).pipe(Schema3.brand("Lexicon:tid")),
    recipientDid: lexString({ format: "did", type: "string" }).pipe(
      Schema3.brand("Lexicon:did")
    ),
    recipientKeyId: lexString({
      description: "DID URL of recipient's keyAgreement key; checked against recipientDid.",
      format: "uri",
      type: "string"
    }).pipe(Schema3.brand("Lexicon:uri")),
    senderDid: lexString({ format: "did", type: "string" }).pipe(
      Schema3.brand("Lexicon:did")
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var AppSignature = Schema3.StructWithRest(
  Schema3.Struct({
    algorithm: lexString({
      knownValues: ["ES256", "ES256K"],
      type: "string"
    }),
    keyId: lexString({
      description: "DID URL of sender's authorized signing key at send time.",
      format: "uri",
      type: "string"
    }).pipe(Schema3.brand("Lexicon:uri")),
    publicKeyMultibase: Schema3.optionalKey(
      lexString({
        description: "Optional historical key hint, never authority without verified key history.",
        type: "string"
      })
    ),
    signature: Bytes.check(
      Schema3.makeFilter(
        (value) => value.length >= 0 && value.length <= 9007199254740991,
        { expected: "byte length constraints" }
      )
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var BirthContext = Schema3.StructWithRest(
  Schema3.Struct({
    createdAt: Schema3.optionalKey(
      lexString({ format: "datetime", type: "string" }).pipe(
        Schema3.brand("Lexicon:datetime")
      )
    ),
    operator: lexString({
      description: "Public operator namespace label, not a private person name.",
      type: "string"
    }),
    project: lexString({
      description: "Public project namespace at birth, not the current assignment.",
      type: "string"
    })
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var DelegationReceipt = Schema3.StructWithRest(
  Schema3.Struct({
    to: lexString({ type: "string" }),
    until: Schema3.optionalKey(
      lexString({ format: "datetime", type: "string" }).pipe(
        Schema3.brand("Lexicon:datetime")
      )
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var DeliveryState = lexString({
  description: "Open values: accepted = durable admission; queued = awaiting runtime; delivered = injected into leased runtime, not processed; acked = recipient acknowledgment; expired = sender-set expiry reached; failed = terminal failure with a receipt. Unknown values are not success.",
  knownValues: [
    "accepted",
    "queued",
    "delivered",
    "acked",
    "expired",
    "failed"
  ],
  type: "string"
});
var PublicJwk = Schema3.StructWithRest(
  Schema3.Struct({
    crv: lexString({ const: "P-256", type: "string" }).pipe(
      Schema3.decodeTo(Schema3.Literal("P-256"))
    ),
    kty: lexString({ const: "EC", type: "string" }).pipe(
      Schema3.decodeTo(Schema3.Literal("EC"))
    ),
    x: lexString({ type: "string" }),
    y: lexString({ type: "string" })
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var DidVerificationMethod = Schema3.StructWithRest(
  Schema3.Struct({
    controller: lexString({ type: "string" }),
    id: lexString({ type: "string" }),
    publicKeyJwk: PublicJwk
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var DidDocument = Schema3.StructWithRest(
  Schema3.Struct({
    authentication: Schema3.Array(lexString({ type: "string" })).check(
      Schema3.isMinLength(0),
      Schema3.isMaxLength(9007199254740991)
    ),
    id: lexString({ format: "did", type: "string" }).pipe(
      Schema3.brand("Lexicon:did")
    ),
    keyAgreement: Schema3.Array(lexString({ type: "string" })).check(
      Schema3.isMinLength(0),
      Schema3.isMaxLength(9007199254740991)
    ),
    verificationMethod: Schema3.Array(DidVerificationMethod).check(
      Schema3.isMinLength(0),
      Schema3.isMaxLength(9007199254740991)
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var HpkeSuite = Schema3.StructWithRest(
  Schema3.Struct({
    aeadId: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(0),
      Schema3.isLessThanOrEqualTo(65535)
    ),
    kdfId: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(0),
      Schema3.isLessThanOrEqualTo(65535)
    ),
    kemId: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(0),
      Schema3.isLessThanOrEqualTo(65535)
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var EncryptedEnvelope = Schema3.StructWithRest(
  Schema3.Struct({
    aad: Aad,
    ciphertext: Bytes.check(
      Schema3.makeFilter(
        (value) => value.length >= 1 && value.length <= 9007199254740991,
        { expected: "byte length constraints" }
      )
    ),
    enc: Bytes.check(
      Schema3.makeFilter(
        (value) => value.length >= 1 && value.length <= 9007199254740991,
        { expected: "byte length constraints" }
      )
    ),
    suite: HpkeSuite,
    version: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(1),
      Schema3.isLessThanOrEqualTo(9007199254740991)
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var MessageRef = Schema3.StructWithRest(
  Schema3.Struct({
    cid: Schema3.optionalKey(
      lexString({
        description: "Optional CID of that exact persisted record, not a hash of JSON.",
        format: "cid",
        type: "string"
      }).pipe(Schema3.brand("Lexicon:cid"))
    ),
    messageId: lexString({ format: "tid", type: "string" }).pipe(
      Schema3.brand("Lexicon:tid")
    ),
    senderDid: lexString({ format: "did", type: "string" }).pipe(
      Schema3.brand("Lexicon:did")
    ),
    uri: Schema3.optionalKey(
      lexString({
        description: "Optional actual persisted record URI; never fabricate a phase-0 record locator.",
        format: "at-uri",
        type: "string"
      }).pipe(Schema3.brand("Lexicon:at-uri"))
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var SignedPass = Schema3.StructWithRest(
  Schema3.Struct({
    record: Main,
    signature: lexString({ type: "string" }).check(
      Schema3.isPattern(/^[A-Za-z0-9_-]{86}$/u)
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var PassRun = lexString({
  description: "Launcher-minted run handle '<label>:<id>'. The label is a lowercase agent label; the id is the worker's session UUID or 32 lowercase hex characters.",
  maxLength: 69,
  type: "string"
}).check(
  Schema3.isPattern(
    /^[a-z][a-z0-9_-]{0,31}:(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u
  )
);
var Via = Schema3.StructWithRest(
  Schema3.Struct({
    desk: lexString({ maxLength: 256, minLength: 1, type: "string" }),
    deskDid: lexString({ format: "did", type: "string" }).pipe(
      Schema3.brand("Lexicon:did")
    ),
    pass: SignedPass,
    run: PassRun,
    worker: lexString({ format: "did", type: "string" }).pipe(
      Schema3.brand("Lexicon:did")
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var Receipt = Schema3.StructWithRest(
  Schema3.Struct({
    delegated: Schema3.optionalKey(DelegationReceipt),
    delegatedFor: Schema3.optionalKey(lexString({ type: "string" })),
    delegatedTo: Schema3.optionalKey(lexString({ type: "string" })),
    detail: Schema3.optionalKey(
      lexString({
        description: "Optional public-safe failure or expiry explanation.",
        type: "string"
      })
    ),
    message: MessageRef,
    originalId: Schema3.optionalKey(
      lexString({ format: "tid", type: "string" }).pipe(
        Schema3.brand("Lexicon:tid")
      )
    ),
    recipientDid: lexString({ format: "did", type: "string" }).pipe(
      Schema3.brand("Lexicon:did")
    ),
    recordedAt: Schema3.optionalKey(
      lexString({ format: "datetime", type: "string" }).pipe(
        Schema3.brand("Lexicon:datetime")
      )
    ),
    seq: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(1),
      Schema3.isLessThanOrEqualTo(9007199254740991)
    ),
    state: DeliveryState,
    via: Schema3.optionalKey(Via),
    wakeReason: Schema3.optionalKey(lexString({ type: "string" })),
    woke: Schema3.optionalKey(Schema3.Boolean)
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var MessageEvent = Schema3.StructWithRest(
  Schema3.Struct({
    envelope: EncryptedEnvelope,
    receipt: Receipt,
    seq: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(1),
      Schema3.isLessThanOrEqualTo(9007199254740991)
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var PassIntent = Schema3.StructWithRest(
  Schema3.Struct({
    wakeReason: lexString({
      enum: ["to", "quiet"],
      type: "string"
    }).pipe(Schema3.decodeTo(Schema3.Literals(["to", "quiet"]))),
    woke: Schema3.Boolean
  }),
  [Schema3.Record(Schema3.String, Data)]
).check(
  Schema3.makeFilter(
    (value) => Object.keys(value).every((key) => ["wakeReason", "woke"].includes(key)),
    { expected: "only allowed keys: wakeReason, woke" }
  )
);
var PassRequest = Schema3.StructWithRest(
  Schema3.Struct({
    aud: lexString({
      description: "The mailbox service DID URL, such as <SERVICE_DID>#mailbox. ASCII only, so no two audiences share signing bytes.",
      maxLength: 512,
      type: "string"
    }).check(
      Schema3.isPattern(/^did:[a-z]+:[A-Za-z0-9._:%-]+#[A-Za-z0-9._~-]+$/u)
    ),
    envelopeDigest: lexString({ type: "string" }).check(
      Schema3.isPattern(/^[A-Za-z0-9_-]{43}$/u)
    ),
    exp: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(0),
      Schema3.isLessThanOrEqualTo(9007199254740991)
    ),
    iat: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(0),
      Schema3.isLessThanOrEqualTo(9007199254740991)
    ),
    intent: PassIntent,
    jti: lexString({ type: "string" }).check(
      Schema3.isPattern(/^[A-Za-z0-9_-]{16,128}$/u)
    ),
    lxm: lexString({ format: "nsid", type: "string" }).pipe(
      Schema3.brand("Lexicon:nsid")
    ),
    passDigest: lexString({ type: "string" }).check(
      Schema3.isPattern(/^[A-Za-z0-9_-]{43}$/u)
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
).check(
  Schema3.makeFilter(
    (value) => Object.keys(value).every(
      (key) => [
        "aud",
        "envelopeDigest",
        "exp",
        "iat",
        "intent",
        "jti",
        "lxm",
        "passDigest"
      ].includes(key)
    ),
    {
      expected: "only allowed keys: aud, envelopeDigest, exp, iat, intent, jti, lxm, passDigest"
    }
  )
);
var ReceiptEvent = Schema3.StructWithRest(
  Schema3.Struct({
    receipt: Receipt,
    seq: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(1),
      Schema3.isLessThanOrEqualTo(9007199254740991)
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var SignedMessage = Schema3.StructWithRest(
  Schema3.Struct({
    appSignature: AppSignature,
    canonicalSigningBytes: Bytes.check(
      Schema3.makeFilter(
        (value) => value.length >= 0 && value.length <= 9007199254740991,
        { expected: "byte length constraints" }
      )
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);
var SigningPayload = Schema3.StructWithRest(
  Schema3.Struct({
    aad: Aad,
    body: Bytes.check(
      Schema3.makeFilter(
        (value) => value.length >= 0 && value.length <= 9007199254740991,
        { expected: "byte length constraints" }
      )
    ),
    createdAt: Schema3.optionalKey(
      lexString({ format: "datetime", type: "string" }).pipe(
        Schema3.brand("Lexicon:datetime")
      )
    ),
    replyTo: Schema3.optionalKey(MessageRef),
    suite: HpkeSuite,
    urgent: Schema3.optionalKey(Schema3.Literal(true)),
    version: Schema3.Int.check(
      Schema3.isGreaterThanOrEqualTo(1),
      Schema3.isLessThanOrEqualTo(9007199254740991)
    )
  }),
  [Schema3.Record(Schema3.String, Data)]
);

// packages/envelope/src/envelope.ts
import { Effect as Effect5, Schema as Schema7 } from "effect";

// packages/envelope/src/canonical.ts
import { decode, encode } from "@ipld/dag-cbor";
import { Effect, Schema as Schema5 } from "effect";

// packages/envelope/src/bytes.ts
var concatenate = (...parts) => {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

// packages/envelope/src/failure.ts
import { Schema as Schema4 } from "effect";
var EnvelopeFailure = class extends Schema4.TaggedError()(
  "EnvelopeFailure",
  { reason: Schema4.String }
) {
};

// packages/envelope/src/canonical.ts
var suite = Object.freeze({ aeadId: 1, kdfId: 1, kemId: 16 });
var plaintextSuite = Object.freeze({
  aeadId: 0,
  kdfId: 0,
  kemId: 0
});
var plaintextEnc = () => Uint8Array.of(0);
var signatureDomain = new TextEncoder().encode(
  "sh.mschf.ratking.signature.v1\0"
);
var aadDomain = new TextEncoder().encode("sh.mschf.ratking.aad.v1\0");
var equalBytes = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]);
var canonical = (value) => encode(value);
var canonicalDecode = Effect.fn("Envelope.canonicalDecode")(
  function* canonicalDecode2(bytes2) {
    const value = yield* Effect.try({
      catch: () => new EnvelopeFailure({ reason: "Invalid CBOR" }),
      try: () => decode(bytes2)
    });
    const parsed = yield* Schema5.decodeUnknownEffect(
      Schema5.toType(Data)
    )(value).pipe(
      Effect.mapError(
        () => new EnvelopeFailure({ reason: "Invalid data model" })
      )
    );
    if (!equalBytes(bytes2, canonical(parsed))) {
      return yield* Effect.fail(
        new EnvelopeFailure({ reason: "Noncanonical CBOR" })
      );
    }
    return parsed;
  }
);
var signingBytes = (payload) => concatenate(signatureDomain, canonical(payload));
var aadBytes = (envelope) => concatenate(
  aadDomain,
  canonical({
    aad: envelope.aad,
    enc: envelope.enc,
    suite: envelope.suite,
    version: envelope.version
  })
);
var plaintext = (envelope) => envelope.version === 1 && equalBytes(canonical(envelope.suite), canonical(plaintextSuite));
var supported = (envelope) => plaintext(envelope) || envelope.version === 1 && equalBytes(canonical(envelope.suite), canonical(suite));

// packages/envelope/src/es256.ts
import { Effect as Effect3 } from "effect";

// packages/envelope/src/webcrypto.ts
import { Effect as Effect2 } from "effect";
var cryptoOperation = (operation) => Effect2.tryPromise({
  catch: () => new EnvelopeFailure({ reason: "Cryptographic operation rejected" }),
  try: operation
});

// packages/envelope/src/es256.ts
var p256Order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
var scalar = (bytes2) => BigInt(
  `0x${Array.from(bytes2, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
);
var scalarBytes = (value) => Uint8Array.from(
  value.toString(16).padStart(64, "0").match(/../gu) ?? [],
  (pair) => Number.parseInt(pair, 16)
);
var normalizeSignature = (signature3) => {
  if (signature3.length !== 64) {
    throw new EnvelopeFailure({ reason: "ES256 requires 64 bytes" });
  }
  const s = scalar(signature3.subarray(32));
  return concatenate(
    signature3.subarray(0, 32),
    scalarBytes(s > p256Order / 2n ? p256Order - s : s)
  );
};
var lowS = (signature3) => signature3.length === 64 && scalar(signature3.subarray(0, 32)) > 0n && scalar(signature3.subarray(0, 32)) < p256Order && scalar(signature3.subarray(32)) > 0n && scalar(signature3.subarray(32)) <= p256Order / 2n;
var sign = Effect3.fn("Envelope.sign")(function* sign2(key, bytes2) {
  const signature3 = yield* cryptoOperation(
    () => crypto.subtle.sign(
      { hash: "SHA-256", name: "ECDSA" },
      key,
      new Uint8Array(bytes2)
    )
  );
  return normalizeSignature(new Uint8Array(signature3));
});
var verify = Effect3.fn("Envelope.verify")(function* verify2(key, bytes2, signature3) {
  if (!lowS(signature3)) {
    return false;
  }
  return yield* cryptoOperation(
    () => crypto.subtle.verify(
      { hash: "SHA-256", name: "ECDSA" },
      key,
      new Uint8Array(signature3),
      new Uint8Array(bytes2)
    )
  );
});

// packages/envelope/src/hpke-p256.ts
import { DhkemP256HkdfSha256 } from "@hpke/core";
var spkiPrefix = Uint8Array.from([
  48,
  89,
  48,
  19,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  8,
  42,
  134,
  72,
  206,
  61,
  3,
  1,
  7,
  3,
  66,
  0
]);
var p256PublicPoint = (raw) => {
  const bytes2 = new Uint8Array(raw);
  if (bytes2.length === 65 && bytes2[0] === 4) {
    return raw;
  }
  if (bytes2.length === 91 && spkiPrefix.every((byte, index) => bytes2[index] === byte) && bytes2[26] === 4) {
    return raw.slice(26);
  }
  throw new EnvelopeFailure({ reason: "Invalid raw P-256 public key export" });
};
var p256Prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
var p256B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
var coordinate = (bytes2) => bytes2.reduce((value, byte) => value * 256n + BigInt(byte), 0n);
var base64url = (bytes2) => btoa(String.fromCodePoint(...bytes2)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
var p256PublicJwk = (raw) => {
  const bytes2 = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
  if (bytes2.length !== 65 || bytes2[0] !== 4) {
    throw new EnvelopeFailure({ reason: "Invalid SEC1 P-256 public key" });
  }
  const xBytes = bytes2.subarray(1, 33);
  const yBytes = bytes2.subarray(33);
  const x = coordinate(xBytes);
  const y = coordinate(yBytes);
  const rhs = ((x * x * x - 3n * x + p256B) % p256Prime + p256Prime) % p256Prime;
  if (x >= p256Prime || y >= p256Prime || y * y % p256Prime !== rhs) {
    throw new EnvelopeFailure({ reason: "Off-curve P-256 public key" });
  }
  return {
    crv: "P-256",
    kty: "EC",
    x: base64url(xBytes),
    y: base64url(yBytes)
  };
};
var CompatibleP256Kem = class extends DhkemP256HkdfSha256 {
  constructor() {
    super();
    const serialize = this._prim.serializePublicKey.bind(this._prim);
    this._prim.deserializePublicKey = async (raw) => await this._prim.importKey("jwk", p256PublicJwk(raw), true);
    this._prim.serializePublicKey = async (key) => {
      const raw = await serialize(key);
      if (key.type === "public" && "namedCurve" in key.algorithm && key.algorithm.namedCurve === "P-256") {
        return p256PublicPoint(raw);
      }
      return raw;
    };
  }
};

// packages/envelope/src/signed.ts
import { Effect as Effect4, Schema as Schema6 } from "effect";
var decodeSigned = Effect4.fn("Envelope.decodeSigned")(function* decodeSigned2(signedBytes) {
  const signed = yield* Schema6.decodeUnknownEffect(
    Schema6.toType(SignedMessage)
  )(yield* canonicalDecode(signedBytes));
  const bytes2 = signed.canonicalSigningBytes;
  if (!equalBytes(bytes2.subarray(0, signatureDomain.length), signatureDomain)) {
    return yield* Effect4.fail(
      new EnvelopeFailure({ reason: "Wrong signature domain" })
    );
  }
  const payload = yield* Schema6.decodeUnknownEffect(
    Schema6.toType(SigningPayload)
  )(yield* canonicalDecode(bytes2.subarray(signatureDomain.length)));
  return { bytes: bytes2, payload, signed };
});
var verifySigned = Effect4.fn("Envelope.verifySigned")(
  function* verifySigned2(envelope, signedBytes, resolveSigningKey) {
    const { bytes: bytes2, payload, signed } = yield* decodeSigned(signedBytes);
    if (!equalBytes(
      canonical({
        aad: payload.aad,
        suite: payload.suite,
        version: payload.version
      }),
      canonical({
        aad: envelope.aad,
        suite: envelope.suite,
        version: envelope.version
      })
    )) {
      return yield* Effect4.fail(
        new EnvelopeFailure({ reason: "Inner metadata mismatch" })
      );
    }
    const app = signed.appSignature;
    if (app.algorithm !== "ES256" || !app.keyId.startsWith(`${envelope.aad.senderDid}#`)) {
      return yield* Effect4.fail(
        new EnvelopeFailure({ reason: "Unauthorized signing key" })
      );
    }
    const key = yield* resolveSigningKey(envelope.aad.senderDid, app.keyId);
    if (!(yield* verify(key, bytes2, app.signature))) {
      return yield* Effect4.fail(
        new EnvelopeFailure({ reason: "Invalid application signature" })
      );
    }
    return payload;
  }
);
var openPlaintext = Effect4.fn("Envelope.openPlaintext")(
  function* openPlaintext2(envelope, resolveSigningKey) {
    if (!plaintext(envelope) || !equalBytes(envelope.enc, plaintextEnc())) {
      return yield* Effect4.fail(
        new EnvelopeFailure({ reason: "Not a signed plaintext envelope" })
      );
    }
    return yield* verifySigned(
      envelope,
      envelope.ciphertext,
      resolveSigningKey
    );
  }
);
var plaintextBody = Effect4.fn("Envelope.plaintextBody")(
  function* plaintextBody2(envelope) {
    if (!plaintext(envelope)) {
      return yield* Effect4.fail(
        new EnvelopeFailure({ reason: "Not a signed plaintext envelope" })
      );
    }
    const { payload } = yield* decodeSigned(envelope.ciphertext);
    return yield* Effect4.try({
      catch: () => new EnvelopeFailure({ reason: "Invalid UTF-8 body" }),
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        payload.body
      )
    });
  }
);

// packages/envelope/src/envelope.ts
var hpke = new CipherSuite({
  aead: new Aes128Gcm(),
  kdf: new HkdfSha256(),
  kem: new CompatibleP256Kem()
});
var info = new TextEncoder().encode("sh.mschf.ratking.hpke.v1");
var seal = Effect5.fn("Envelope.seal")(function* seal2(request) {
  const { payload } = request;
  if (!supported(payload) || request.recipientKeyId !== payload.aad.recipientKeyId || !request.recipientKeyId.startsWith(`${payload.aad.recipientDid}#`) || !request.signingKeyId.startsWith(`${payload.aad.senderDid}#`)) {
    return yield* Effect5.fail(
      new EnvelopeFailure({
        reason: "Unsupported envelope or unauthorized key id"
      })
    );
  }
  const validated = yield* Schema7.decodeUnknownEffect(
    Schema7.toType(SigningPayload)
  )(payload);
  const bytes2 = signingBytes(validated);
  const signature3 = yield* sign(request.signingKey, bytes2);
  const signed = yield* Schema7.decodeUnknownEffect(
    Schema7.toType(SignedMessage)
  )({
    appSignature: {
      algorithm: "ES256",
      keyId: request.signingKeyId,
      signature: signature3
    },
    canonicalSigningBytes: bytes2
  });
  if (plaintext(payload)) {
    return yield* Schema7.decodeUnknownEffect(
      Schema7.toType(EncryptedEnvelope)
    )({
      aad: payload.aad,
      ciphertext: canonical(signed),
      enc: plaintextEnc(),
      suite: payload.suite,
      version: payload.version
    });
  }
  const context = yield* cryptoOperation(
    () => hpke.createSenderContext({ info, recipientPublicKey: request.recipientKey })
  );
  const header = {
    aad: payload.aad,
    enc: new Uint8Array(context.enc),
    suite: payload.suite,
    version: payload.version
  };
  const ciphertext = yield* cryptoOperation(
    () => context.seal(canonical(signed), aadBytes(header))
  );
  return yield* Schema7.decodeUnknownEffect(
    Schema7.toType(EncryptedEnvelope)
  )({ ...header, ciphertext: new Uint8Array(ciphertext) });
});
var open = Effect5.fn("Envelope.open")(function* open2(request) {
  const envelope = yield* Schema7.decodeUnknownEffect(
    Schema7.toType(EncryptedEnvelope)
  )(request.envelope);
  if (!supported(envelope) || envelope.aad.recipientDid !== request.recipientDid || envelope.aad.recipientKeyId !== request.recipientKeyId || !request.recipientKeyId.startsWith(`${request.recipientDid}#`)) {
    return yield* Effect5.fail(
      new EnvelopeFailure({ reason: "Unsupported envelope or wrong recipient" })
    );
  }
  if (plaintext(envelope)) {
    return yield* openPlaintext(envelope, request.resolveSigningKey);
  }
  const context = yield* cryptoOperation(
    () => hpke.createRecipientContext({
      enc: envelope.enc,
      info,
      recipientKey: request.recipientKey
    })
  );
  const opened = yield* cryptoOperation(
    () => context.open(envelope.ciphertext, aadBytes(envelope))
  );
  return yield* verifySigned(
    envelope,
    new Uint8Array(opened),
    request.resolveSigningKey
  );
});

// packages/lexicon/src/admin.putDidDocument.ts
import { Schema as Schema8 } from "effect";
var Params = Schema8.Undefined;
var Input = Schema8.StructWithRest(
  Schema8.Struct({ document: DidDocument }),
  [Schema8.Record(Schema8.String, Data)]
);
var Output = Schema8.StructWithRest(
  Schema8.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema8.brand("Lexicon:did")
    )
  }),
  [Schema8.Record(Schema8.String, Data)]
);
var ErrorBody = XrpcErrorBody;
var Method = {
  defaults: {},
  error: ErrorBody,
  input: Input,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.admin.putDidDocument",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.admin.putDidDocument"
};

// packages/lexicon/src/mailbox-client.ts
import { Context as Context2, Effect as Effect10, Layer, Result, Schema as Schema26 } from "effect";

// packages/lexicon/src/attention.getPreferences.ts
import { Effect as Effect6, Schema as Schema11 } from "effect";

// packages/lexicon/src/attention.prefs.ts
import { Schema as Schema9 } from "effect";
var Name = lexString({
  maxLength: 128,
  minLength: 1,
  type: "string"
}).check(Schema9.isPattern(/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/u));
var Digest = Schema9.StructWithRest(
  Schema9.Struct({
    minutes: Schema9.Int.check(
      Schema9.isGreaterThanOrEqualTo(1),
      Schema9.isLessThanOrEqualTo(1440)
    ),
    name: Name
  }),
  [Schema9.Record(Schema9.String, Data)]
).check(
  Schema9.makeFilter(
    (value) => Object.keys(value).every((key) => ["minutes", "name"].includes(key)),
    { expected: "only allowed keys: minutes, name" }
  )
);
var Group = Schema9.StructWithRest(
  Schema9.Struct({
    group: lexString({ maxLength: 256, minLength: 1, type: "string" })
  }),
  [Schema9.Record(Schema9.String, Data)]
).check(
  Schema9.makeFilter(
    (value) => Object.keys(value).every((key) => ["group"].includes(key)),
    { expected: "only allowed keys: group" }
  )
);
var Jev = Schema9.StructWithRest(
  Schema9.Struct({
    judgment: lexString({
      maxLength: 280,
      minLength: 1,
      type: "string"
    }),
    laterBp: Schema9.Int.check(
      Schema9.isGreaterThanOrEqualTo(0),
      Schema9.isLessThanOrEqualTo(1e4)
    ),
    nowBp: Schema9.Int.check(
      Schema9.isGreaterThanOrEqualTo(0),
      Schema9.isLessThanOrEqualTo(1e4)
    )
  }),
  [Schema9.Record(Schema9.String, Data)]
).check(
  Schema9.makeFilter(
    (value) => Object.keys(value).every(
      (key) => ["judgment", "laterBp", "nowBp"].includes(key)
    ),
    { expected: "only allowed keys: judgment, laterBp, nowBp" }
  )
);
var Model = Schema9.StructWithRest(
  Schema9.Struct({
    body: lexString({
      enum: ["never", "summary", "full"],
      type: "string"
    }).pipe(Schema9.decodeTo(Schema9.Literals(["never", "summary", "full"]))),
    jev: Schema9.optionalKey(Jev),
    kind: lexString({
      enum: ["none", "jev", "service"],
      type: "string"
    }).pipe(Schema9.decodeTo(Schema9.Literals(["none", "jev", "service"]))),
    service: Schema9.optionalKey(
      lexString({ maxLength: 256, minLength: 1, type: "string" }).check(
        Schema9.isPattern(
          /^(?:did:[a-z]+:[^\s]+|[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*)$/u
        )
      )
    ),
    timeoutMs: Schema9.Int.check(
      Schema9.isGreaterThanOrEqualTo(1),
      Schema9.isLessThanOrEqualTo(6e5)
    )
  }),
  [Schema9.Record(Schema9.String, Data)]
).check(
  Schema9.makeFilter(
    (value) => Object.keys(value).every(
      (key) => ["body", "jev", "kind", "service", "timeoutMs"].includes(key)
    ),
    { expected: "only allowed keys: body, jev, kind, service, timeoutMs" }
  )
).check(
  Schema9.makeFilter(
    (value) => value.kind !== "jev" || value.jev !== void 0,
    { expected: "jev: required when kind is jev" }
  )
);
var Match = Schema9.StructWithRest(
  Schema9.Struct({
    from: Schema9.optionalKey(
      lexString({ maxLength: 129, minLength: 1, type: "string" }).check(
        Schema9.isPattern(
          /^(?:[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*|[a-z][a-z0-9_/-]*\*|\*)$/u
        )
      )
    ),
    project: Schema9.optionalKey(
      lexString({ maxLength: 128, minLength: 1, type: "string" }).check(
        Schema9.isPattern(/^[a-z][a-z0-9_-]*$/u)
      )
    ),
    type: Schema9.optionalKey(
      lexString({ maxLength: 256, minLength: 1, type: "string" })
    )
  }),
  [Schema9.Record(Schema9.String, Data)]
).check(
  Schema9.makeFilter(
    (value) => Object.keys(value).every(
      (key) => ["from", "project", "type"].includes(key)
    ),
    { expected: "only allowed keys: from, project, type" }
  )
);
var Rule = Schema9.StructWithRest(
  Schema9.Struct({
    id: lexString({
      maxLength: 64,
      minLength: 1,
      type: "string"
    }).check(Schema9.isPattern(/^[a-zA-Z0-9_-]+$/u)),
    match: Match,
    minutes: Schema9.optionalKey(
      Schema9.Int.check(
        Schema9.isGreaterThanOrEqualTo(1),
        Schema9.isLessThanOrEqualTo(1440)
      )
    ),
    note: Schema9.optionalKey(
      lexString({ maxLength: 280, type: "string" })
    ),
    route: lexString({
      enum: ["wake", "quiet", "digest", "hide"],
      type: "string"
    }).pipe(
      Schema9.decodeTo(Schema9.Literals(["wake", "quiet", "digest", "hide"]))
    ),
    until: Schema9.optionalKey(
      lexString({ format: "datetime", type: "string" }).pipe(
        Schema9.brand("Lexicon:datetime")
      )
    )
  }),
  [Schema9.Record(Schema9.String, Data)]
).check(
  Schema9.makeFilter(
    (value) => Object.keys(value).every(
      (key) => ["id", "match", "minutes", "note", "route", "until"].includes(key)
    ),
    { expected: "only allowed keys: id, match, minutes, note, route, until" }
  )
).check(
  Schema9.makeFilter(
    (value) => value.route !== "digest" || value.minutes !== void 0,
    { expected: "minutes: required when route is digest" }
  )
).check(
  Schema9.makeFilter(
    (value) => !("minutes" in value) || value.route === "digest",
    { expected: "minutes: allowed only when route is digest" }
  )
);
var Main2 = Schema9.StructWithRest(
  Schema9.Struct({
    allow: Schema9.Array(Name).check(
      Schema9.isMinLength(0),
      Schema9.isMaxLength(256)
    ),
    digest: Schema9.optionalKey(
      Schema9.Array(Digest).check(Schema9.isMinLength(0), Schema9.isMaxLength(256))
    ),
    forward: Schema9.Array(Name).check(
      Schema9.isMinLength(0),
      Schema9.isMaxLength(256)
    ),
    log: Schema9.Boolean,
    model: Model,
    mute: Schema9.Array(
      Schema9.Union([
        Schema9.StructWithRest(
          Schema9.Struct({
            $type: Schema9.Literal("sh.mschf.ratking.attention.prefs#thread"),
            thread: lexString({
              maxLength: 256,
              minLength: 1,
              type: "string"
            })
          }),
          [Schema9.Record(Schema9.String, Data)]
        ).check(
          Schema9.makeFilter(
            (value) => Object.keys(value).every(
              (key) => ["$type", "thread"].includes(key)
            ),
            { expected: "only allowed keys: $type, thread" }
          )
        ),
        Schema9.StructWithRest(
          Schema9.Struct({
            $type: Schema9.Literal("sh.mschf.ratking.attention.prefs#group"),
            group: lexString({
              maxLength: 256,
              minLength: 1,
              type: "string"
            })
          }),
          [Schema9.Record(Schema9.String, Data)]
        ).check(
          Schema9.makeFilter(
            (value) => Object.keys(value).every(
              (key) => ["$type", "group"].includes(key)
            ),
            { expected: "only allowed keys: $type, group" }
          )
        )
      ])
    ).check(Schema9.isMinLength(0), Schema9.isMaxLength(256)),
    refuse: Schema9.Array(Name).check(
      Schema9.isMinLength(0),
      Schema9.isMaxLength(256)
    ),
    rules: Schema9.optionalKey(
      Schema9.Array(Rule).check(Schema9.isMinLength(0), Schema9.isMaxLength(32))
    ),
    version: lexString({ const: "0.1", type: "string" }).pipe(
      Schema9.decodeTo(Schema9.Literal("0.1"))
    )
  }),
  [Schema9.Record(Schema9.String, Data)]
).check(
  Schema9.makeFilter(
    (value) => Object.keys(value).every(
      (key) => [
        "allow",
        "digest",
        "forward",
        "log",
        "model",
        "mute",
        "refuse",
        "rules",
        "version"
      ].includes(key)
    ),
    {
      expected: "only allowed keys: allow, digest, forward, log, model, mute, refuse, rules, version"
    }
  )
);
var Thread = Schema9.StructWithRest(
  Schema9.Struct({
    thread: lexString({ maxLength: 256, minLength: 1, type: "string" })
  }),
  [Schema9.Record(Schema9.String, Data)]
).check(
  Schema9.makeFilter(
    (value) => Object.keys(value).every((key) => ["thread"].includes(key)),
    { expected: "only allowed keys: thread" }
  )
);

// packages/lexicon/src/query.ts
import { Schema as Schema10, SchemaGetter as SchemaGetter2 } from "effect";
var BooleanFromQuery = Schema10.Literals(["true", "false"]).pipe(
  Schema10.decodeTo(Schema10.Boolean, {
    decode: SchemaGetter2.transform((value) => value === "true"),
    encode: SchemaGetter2.transform((value) => value ? "true" : "false")
  })
);
var Value = Schema10.Union([Schema10.String, Schema10.Array(Schema10.String)]);
var Params2 = Schema10.Record(Schema10.String, Value);
var entries = (params) => [...Object.entries(params)].sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, value]) => {
  if (Schema10.is(Schema10.String)(value)) {
    return [[key, value]];
  }
  return value.map(
    (item) => [key, item]
  );
});
var parameters = (pairs) => {
  const grouped = /* @__PURE__ */ new Map();
  for (const [key, value] of pairs) {
    const previous = grouped.get(key);
    if (previous === void 0) {
      grouped.set(key, value);
    } else if (Schema10.is(Schema10.String)(previous)) {
      grouped.set(key, [previous, value]);
    } else {
      grouped.set(key, [...previous, value]);
    }
  }
  return Object.fromEntries(grouped);
};

// packages/lexicon/src/attention.getPreferences.ts
var Params3 = Schema11.StructWithRest(
  Schema11.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema11.brand("Lexicon:did")
    )
  }),
  [Schema11.Record(Schema11.String, Data)]
);
var Input2 = Schema11.Undefined;
var Output2 = Schema11.StructWithRest(
  Schema11.Struct({ prefs: Main2 }),
  [Schema11.Record(Schema11.String, Data)]
);
var ParamsFromQuery = Schema11.StructWithRest(
  Schema11.Struct({ did: Schema11.String }),
  [Schema11.Record(Schema11.String, Data)]
).pipe(Schema11.decodeTo(Params3));
var encodeParams = Effect6.fn("lexicon.encodeParams")(
  function* encodeParams2(params) {
    return entries(
      yield* Schema11.decodeUnknownEffect(Params2)(
        yield* Schema11.encodeEffect(ParamsFromQuery)(params)
      )
    );
  }
);
var decodeParams = Effect6.fn("lexicon.decodeParams")(
  function* decodeParams2(entries2) {
    return yield* Schema11.decodeUnknownEffect(ParamsFromQuery)(
      parameters(entries2)
    );
  }
);
var ErrorBody2 = XrpcErrorBody;
var Method2 = {
  defaults: {},
  error: ErrorBody2,
  input: Input2,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.attention.getPreferences",
  output: Output2,
  outputEncoding: "application/json",
  params: Params3,
  path: "/xrpc/sh.mschf.ratking.attention.getPreferences"
};

// packages/lexicon/src/attention.getStatus.ts
import { Effect as Effect7, Schema as Schema13 } from "effect";

// packages/lexicon/src/attention.status.ts
import { Schema as Schema12 } from "effect";
var Main3 = Schema12.StructWithRest(
  Schema12.Struct({
    $type: Schema12.Literal("sh.mschf.ratking.attention.status"),
    delegate: Schema12.optionalKey(
      lexString({ type: "string" }).check(
        Schema12.isPattern(
          /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9_-]{0,31}$/u
        )
      )
    ),
    exempt: Schema12.optionalKey(
      Schema12.Array(
        lexString({ type: "string" }).check(
          Schema12.isPattern(
            /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9_-]{0,31}$/u
          )
        )
      ).check(Schema12.isMinLength(0), Schema12.isMaxLength(16))
    ),
    note: Schema12.optionalKey(
      lexString({ maxLength: 120, type: "string" })
    ),
    state: lexString({
      enum: ["available", "busy", "dnd"],
      type: "string"
    }).pipe(Schema12.decodeTo(Schema12.Literals(["available", "busy", "dnd"]))),
    until: Schema12.optionalKey(
      lexString({ format: "datetime", type: "string" }).pipe(
        Schema12.brand("Lexicon:datetime")
      )
    ),
    version: lexString({ const: "0.1", type: "string" }).pipe(
      Schema12.decodeTo(Schema12.Literal("0.1"))
    )
  }),
  [Schema12.Record(Schema12.String, Data)]
);

// packages/lexicon/src/attention.getStatus.ts
var Params4 = Schema13.StructWithRest(
  Schema13.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema13.brand("Lexicon:did")
    )
  }),
  [Schema13.Record(Schema13.String, Data)]
);
var Input3 = Schema13.Undefined;
var Output3 = Schema13.StructWithRest(
  Schema13.Struct({ status: Main3 }),
  [Schema13.Record(Schema13.String, Data)]
);
var ParamsFromQuery2 = Schema13.StructWithRest(
  Schema13.Struct({ did: Schema13.String }),
  [Schema13.Record(Schema13.String, Data)]
).pipe(Schema13.decodeTo(Params4));
var encodeParams3 = Effect7.fn("lexicon.encodeParams")(
  function* encodeParams4(params) {
    return entries(
      yield* Schema13.decodeUnknownEffect(Params2)(
        yield* Schema13.encodeEffect(ParamsFromQuery2)(params)
      )
    );
  }
);
var decodeParams3 = Effect7.fn("lexicon.decodeParams")(
  function* decodeParams4(entries2) {
    return yield* Schema13.decodeUnknownEffect(ParamsFromQuery2)(
      parameters(entries2)
    );
  }
);
var ErrorBody3 = XrpcErrorBody;
var Method3 = {
  defaults: {},
  error: ErrorBody3,
  input: Input3,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.attention.getStatus",
  output: Output3,
  outputEncoding: "application/json",
  params: Params4,
  path: "/xrpc/sh.mschf.ratking.attention.getStatus"
};

// packages/lexicon/src/attention.putPreferences.ts
import { Schema as Schema14 } from "effect";
var Params5 = Schema14.Undefined;
var Input4 = Schema14.StructWithRest(
  Schema14.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema14.brand("Lexicon:did")
    ),
    keyId: lexString({ type: "string" }),
    prefs: Main2,
    signature: Bytes.check(
      Schema14.makeFilter(
        (value) => value.length >= 0 && value.length <= 9007199254740991,
        { expected: "byte length constraints" }
      )
    )
  }),
  [Schema14.Record(Schema14.String, Data)]
);
var Output4 = Schema14.StructWithRest(
  Schema14.Struct({ prefs: Main2 }),
  [Schema14.Record(Schema14.String, Data)]
);
var ErrorBody4 = XrpcErrorBody;
var Method4 = {
  defaults: {},
  error: ErrorBody4,
  input: Input4,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.attention.putPreferences",
  output: Output4,
  outputEncoding: "application/json",
  params: Params5,
  path: "/xrpc/sh.mschf.ratking.attention.putPreferences"
};

// packages/lexicon/src/attention.putStatus.ts
import { Schema as Schema15 } from "effect";
var Params6 = Schema15.Undefined;
var Input5 = Schema15.StructWithRest(
  Schema15.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema15.brand("Lexicon:did")
    ),
    keyId: lexString({ type: "string" }),
    signature: Bytes.check(
      Schema15.makeFilter(
        (value) => value.length >= 0 && value.length <= 9007199254740991,
        { expected: "byte length constraints" }
      )
    ),
    status: Main3
  }),
  [Schema15.Record(Schema15.String, Data)]
);
var Output5 = Schema15.StructWithRest(
  Schema15.Struct({ status: Main3 }),
  [Schema15.Record(Schema15.String, Data)]
);
var ErrorBody5 = XrpcErrorBody;
var Method5 = {
  defaults: {},
  error: ErrorBody5,
  input: Input5,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.attention.putStatus",
  output: Output5,
  outputEncoding: "application/json",
  params: Params6,
  path: "/xrpc/sh.mschf.ratking.attention.putStatus"
};

// packages/lexicon/src/mailbox.ack.ts
import { Schema as Schema16 } from "effect";
var Params7 = Schema16.Undefined;
var Input6 = Schema16.StructWithRest(
  Schema16.Struct({
    generation: Schema16.Int.check(
      Schema16.isGreaterThanOrEqualTo(1),
      Schema16.isLessThanOrEqualTo(9007199254740991)
    ),
    leaseId: lexString({ format: "tid", type: "string" }).pipe(
      Schema16.brand("Lexicon:tid")
    ),
    message: MessageRef,
    recipientDid: lexString({ format: "did", type: "string" }).pipe(
      Schema16.brand("Lexicon:did")
    )
  }),
  [Schema16.Record(Schema16.String, Data)]
);
var Output6 = Schema16.StructWithRest(
  Schema16.Struct({ receipt: Receipt }),
  [Schema16.Record(Schema16.String, Data)]
);
var ErrorBody6 = XrpcErrorBody;
var Method6 = {
  defaults: {},
  error: ErrorBody6,
  input: Input6,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.mailbox.ack",
  output: Output6,
  outputEncoding: "application/json",
  params: Params7,
  path: "/xrpc/sh.mschf.ratking.mailbox.ack"
};

// packages/lexicon/src/mailbox.deliver.ts
import { Schema as Schema17 } from "effect";
var Params8 = Schema17.Undefined;
var Input7 = Schema17.StructWithRest(
  Schema17.Struct({
    generation: Schema17.Int.check(
      Schema17.isGreaterThanOrEqualTo(1),
      Schema17.isLessThanOrEqualTo(9007199254740991)
    ),
    leaseId: lexString({ format: "tid", type: "string" }).pipe(
      Schema17.brand("Lexicon:tid")
    ),
    message: MessageRef,
    recipientDid: lexString({ format: "did", type: "string" }).pipe(
      Schema17.brand("Lexicon:did")
    )
  }),
  [Schema17.Record(Schema17.String, Data)]
);
var Output7 = Schema17.StructWithRest(
  Schema17.Struct({ receipt: Receipt }),
  [Schema17.Record(Schema17.String, Data)]
);
var ErrorBody7 = XrpcErrorBody;
var Method7 = {
  defaults: {},
  error: ErrorBody7,
  input: Input7,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.mailbox.deliver",
  output: Output7,
  outputEncoding: "application/json",
  params: Params8,
  path: "/xrpc/sh.mschf.ratking.mailbox.deliver"
};

// packages/lexicon/src/mailbox.list.ts
import { Effect as Effect8, Schema as Schema18 } from "effect";
var Params9 = Schema18.StructWithRest(
  Schema18.Struct({
    afterSeq: Schema18.optionalKey(
      Schema18.Int.check(
        Schema18.isGreaterThanOrEqualTo(0),
        Schema18.isLessThanOrEqualTo(9007199254740991)
      )
    ),
    cursor: Schema18.optionalKey(
      lexString({
        description: "Opaque snapshot cursor; keep all other parameters fixed while paginating.",
        type: "string"
      })
    ),
    limit: Schema18.optionalKey(
      Schema18.Int.check(
        Schema18.isGreaterThanOrEqualTo(1),
        Schema18.isLessThanOrEqualTo(100)
      )
    ),
    recipientDid: lexString({ format: "did", type: "string" }).pipe(
      Schema18.brand("Lexicon:did")
    )
  }),
  [Schema18.Record(Schema18.String, Data)]
);
var Input8 = Schema18.Undefined;
var Output8 = Schema18.StructWithRest(
  Schema18.Struct({
    cursor: Schema18.optionalKey(
      lexString({
        description: "Present only while more entries remain. Checkpoint throughSeq after processing every page.",
        type: "string"
      })
    ),
    events: Schema18.Array(
      Schema18.Union([
        Schema18.StructWithRest(
          Schema18.Struct({
            $type: Schema18.Literal("sh.mschf.ratking.defs#messageEvent"),
            envelope: EncryptedEnvelope,
            receipt: Receipt,
            seq: Schema18.Int.check(
              Schema18.isGreaterThanOrEqualTo(1),
              Schema18.isLessThanOrEqualTo(9007199254740991)
            )
          }),
          [Schema18.Record(Schema18.String, Data)]
        ),
        Schema18.StructWithRest(
          Schema18.Struct({
            $type: Schema18.Literal("sh.mschf.ratking.defs#receiptEvent"),
            receipt: Receipt,
            seq: Schema18.Int.check(
              Schema18.isGreaterThanOrEqualTo(1),
              Schema18.isLessThanOrEqualTo(9007199254740991)
            )
          }),
          [Schema18.Record(Schema18.String, Data)]
        ),
        Schema18.StructWithRest(
          Schema18.Struct({
            $type: Schema18.Literal("sh.mschf.ratking.attention.receipt"),
            operation: lexString({
              enum: ["putPreferences", "putStatus"],
              type: "string"
            }).pipe(
              Schema18.decodeTo(Schema18.Literals(["putPreferences", "putStatus"]))
            ),
            seq: Schema18.Int.check(
              Schema18.isGreaterThanOrEqualTo(1),
              Schema18.isLessThanOrEqualTo(9007199254740991)
            )
          }),
          [Schema18.Record(Schema18.String, Data)]
        ),
        TaggedMap.check(
          Schema18.makeFilter(
            (value) => ![
              "sh.mschf.ratking.defs#messageEvent",
              "sh.mschf.ratking.defs#receiptEvent",
              "sh.mschf.ratking.attention.receipt"
            ].includes(value.$type),
            { expected: "unknown union tag only" }
          )
        )
      ])
    ).check(Schema18.isMinLength(0), Schema18.isMaxLength(100)),
    throughSeq: Schema18.Int.check(
      Schema18.isGreaterThanOrEqualTo(0),
      Schema18.isLessThanOrEqualTo(9007199254740991)
    )
  }),
  [Schema18.Record(Schema18.String, Data)]
);
var ParamsFromQuery3 = Schema18.StructWithRest(
  Schema18.Struct({
    afterSeq: Schema18.optionalKey(Schema18.FiniteFromString),
    cursor: Schema18.optionalKey(Schema18.String),
    limit: Schema18.optionalKey(Schema18.FiniteFromString),
    recipientDid: Schema18.String
  }),
  [Schema18.Record(Schema18.String, Data)]
).pipe(Schema18.decodeTo(Params9));
var encodeParams5 = Effect8.fn("lexicon.encodeParams")(
  function* encodeParams6(params) {
    return entries(
      yield* Schema18.decodeUnknownEffect(Params2)(
        yield* Schema18.encodeEffect(ParamsFromQuery3)(params)
      )
    );
  }
);
var decodeParams5 = Effect8.fn("lexicon.decodeParams")(
  function* decodeParams6(entries2) {
    return yield* Schema18.decodeUnknownEffect(ParamsFromQuery3)(
      parameters(entries2)
    );
  }
);
var ErrorBody8 = XrpcErrorBody;
var Method8 = {
  defaults: { limit: 50 },
  error: ErrorBody8,
  input: Input8,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.mailbox.list",
  output: Output8,
  outputEncoding: "application/json",
  params: Params9,
  path: "/xrpc/sh.mschf.ratking.mailbox.list"
};

// packages/lexicon/src/mailbox.send.ts
import { Schema as Schema19 } from "effect";
var Params10 = Schema19.Undefined;
var Input9 = Schema19.StructWithRest(
  Schema19.Struct({
    critical: Schema19.optionalKey(Schema19.Boolean),
    envelope: EncryptedEnvelope,
    generation: Schema19.optionalKey(
      Schema19.Int.check(
        Schema19.isGreaterThanOrEqualTo(1),
        Schema19.isLessThanOrEqualTo(9007199254740991)
      )
    ),
    leaseId: Schema19.optionalKey(
      lexString({ format: "tid", type: "string" }).pipe(
        Schema19.brand("Lexicon:tid")
      )
    ),
    wakeReason: Schema19.optionalKey(
      lexString({
        enum: ["to", "ask", "reply", "cc", "quiet", "data"],
        type: "string"
      }).pipe(
        Schema19.decodeTo(
          Schema19.Literals(["to", "ask", "reply", "cc", "quiet", "data"])
        )
      )
    ),
    woke: Schema19.optionalKey(Schema19.Boolean)
  }),
  [Schema19.Record(Schema19.String, Data)]
);
var Output9 = Schema19.StructWithRest(
  Schema19.Struct({ receipt: Receipt }),
  [Schema19.Record(Schema19.String, Data)]
);
var ErrorBody9 = XrpcErrorBody;
var Method9 = {
  defaults: {},
  error: ErrorBody9,
  input: Input9,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.mailbox.send",
  output: Output9,
  outputEncoding: "application/json",
  params: Params10,
  path: "/xrpc/sh.mschf.ratking.mailbox.send"
};

// packages/lexicon/src/runtime.acquireLease.ts
import { Schema as Schema21 } from "effect";

// packages/lexicon/src/runtime.lease.ts
import { Schema as Schema20 } from "effect";
var Claude = Schema20.StructWithRest(
  Schema20.Struct({
    executionId: Schema20.optionalKey(
      lexString({
        description: "Optional run inside the bound session.",
        type: "string"
      })
    ),
    paneId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local pane identifier, never a host address.",
        type: "string"
      })
    ),
    sessionId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string"
      })
    )
  }),
  [Schema20.Record(Schema20.String, Data)]
);
var Codex = Schema20.StructWithRest(
  Schema20.Struct({
    executionId: Schema20.optionalKey(
      lexString({
        description: "Optional run inside the bound session.",
        type: "string"
      })
    ),
    paneId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local pane identifier, never a host address.",
        type: "string"
      })
    ),
    sessionId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string"
      })
    )
  }),
  [Schema20.Record(Schema20.String, Data)]
);
var Main4 = Schema20.StructWithRest(
  Schema20.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema20.brand("Lexicon:did")
    ),
    expiresAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema20.brand("Lexicon:datetime")
    ),
    generation: Schema20.Int.check(
      Schema20.isGreaterThanOrEqualTo(1),
      Schema20.isLessThanOrEqualTo(9007199254740991)
    ),
    harness: Schema20.Union([
      Schema20.StructWithRest(
        Schema20.Struct({
          $type: Schema20.Literal("sh.mschf.ratking.runtime.lease#pi"),
          executionId: Schema20.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          paneId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema20.Record(Schema20.String, Data)]
      ),
      Schema20.StructWithRest(
        Schema20.Struct({
          $type: Schema20.Literal("sh.mschf.ratking.runtime.lease#claude"),
          executionId: Schema20.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          paneId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema20.Record(Schema20.String, Data)]
      ),
      Schema20.StructWithRest(
        Schema20.Struct({
          $type: Schema20.Literal("sh.mschf.ratking.runtime.lease#codex"),
          executionId: Schema20.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          paneId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema20.Record(Schema20.String, Data)]
      ),
      Schema20.StructWithRest(
        Schema20.Struct({
          $type: Schema20.Literal("sh.mschf.ratking.runtime.lease#opencode"),
          executionId: Schema20.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          paneId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema20.Record(Schema20.String, Data)]
      ),
      Schema20.StructWithRest(
        Schema20.Struct({
          $type: Schema20.Literal("sh.mschf.ratking.runtime.lease#other"),
          executionId: Schema20.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          kind: lexString({
            description: "Harness adapter identifier.",
            type: "string"
          }),
          paneId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema20.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema20.Record(Schema20.String, Data)]
      ),
      TaggedMap.check(
        Schema20.makeFilter(
          (value) => ![
            "sh.mschf.ratking.runtime.lease#pi",
            "sh.mschf.ratking.runtime.lease#claude",
            "sh.mschf.ratking.runtime.lease#codex",
            "sh.mschf.ratking.runtime.lease#opencode",
            "sh.mschf.ratking.runtime.lease#other"
          ].includes(value.$type),
          { expected: "unknown union tag only" }
        )
      )
    ]),
    issuedAt: Schema20.optionalKey(
      lexString({ format: "datetime", type: "string" }).pipe(
        Schema20.brand("Lexicon:datetime")
      )
    ),
    leaseId: lexString({ format: "tid", type: "string" }).pipe(
      Schema20.brand("Lexicon:tid")
    ),
    renders: Schema20.optionalKey(
      Schema20.Array(lexString({ type: "string" })).check(
        Schema20.isMinLength(0),
        Schema20.isMaxLength(9007199254740991)
      )
    )
  }),
  [Schema20.Record(Schema20.String, Data)]
);
var Opencode = Schema20.StructWithRest(
  Schema20.Struct({
    executionId: Schema20.optionalKey(
      lexString({
        description: "Optional run inside the bound session.",
        type: "string"
      })
    ),
    paneId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local pane identifier, never a host address.",
        type: "string"
      })
    ),
    sessionId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string"
      })
    )
  }),
  [Schema20.Record(Schema20.String, Data)]
);
var Other = Schema20.StructWithRest(
  Schema20.Struct({
    executionId: Schema20.optionalKey(
      lexString({
        description: "Optional run inside the bound session.",
        type: "string"
      })
    ),
    kind: lexString({
      description: "Harness adapter identifier.",
      type: "string"
    }),
    paneId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local pane identifier, never a host address.",
        type: "string"
      })
    ),
    sessionId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string"
      })
    )
  }),
  [Schema20.Record(Schema20.String, Data)]
);
var Pi = Schema20.StructWithRest(
  Schema20.Struct({
    executionId: Schema20.optionalKey(
      lexString({
        description: "Optional run inside the bound session.",
        type: "string"
      })
    ),
    paneId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local pane identifier, never a host address.",
        type: "string"
      })
    ),
    sessionId: Schema20.optionalKey(
      lexString({
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string"
      })
    )
  }),
  [Schema20.Record(Schema20.String, Data)]
);

// packages/lexicon/src/runtime.acquireLease.ts
var Params11 = Schema21.Undefined;
var Input10 = Schema21.StructWithRest(
  Schema21.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema21.brand("Lexicon:did")
    ),
    expiresAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema21.brand("Lexicon:datetime")
    ),
    generation: Schema21.optionalKey(
      Schema21.Int.check(
        Schema21.isGreaterThanOrEqualTo(1),
        Schema21.isLessThanOrEqualTo(9007199254740991)
      )
    ),
    harness: Schema21.Union([
      Schema21.StructWithRest(
        Schema21.Struct({
          $type: Schema21.Literal("sh.mschf.ratking.runtime.lease#pi"),
          executionId: Schema21.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          paneId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema21.Record(Schema21.String, Data)]
      ),
      Schema21.StructWithRest(
        Schema21.Struct({
          $type: Schema21.Literal("sh.mschf.ratking.runtime.lease#claude"),
          executionId: Schema21.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          paneId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema21.Record(Schema21.String, Data)]
      ),
      Schema21.StructWithRest(
        Schema21.Struct({
          $type: Schema21.Literal("sh.mschf.ratking.runtime.lease#codex"),
          executionId: Schema21.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          paneId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema21.Record(Schema21.String, Data)]
      ),
      Schema21.StructWithRest(
        Schema21.Struct({
          $type: Schema21.Literal("sh.mschf.ratking.runtime.lease#opencode"),
          executionId: Schema21.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          paneId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema21.Record(Schema21.String, Data)]
      ),
      Schema21.StructWithRest(
        Schema21.Struct({
          $type: Schema21.Literal("sh.mschf.ratking.runtime.lease#other"),
          executionId: Schema21.optionalKey(
            lexString({
              description: "Optional run inside the bound session.",
              type: "string"
            })
          ),
          kind: lexString({
            description: "Harness adapter identifier.",
            type: "string"
          }),
          paneId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local pane identifier, never a host address.",
              type: "string"
            })
          ),
          sessionId: Schema21.optionalKey(
            lexString({
              description: "Opaque adapter-local session identifier, never identity.",
              type: "string"
            })
          )
        }),
        [Schema21.Record(Schema21.String, Data)]
      ),
      TaggedMap.check(
        Schema21.makeFilter(
          (value) => ![
            "sh.mschf.ratking.runtime.lease#pi",
            "sh.mschf.ratking.runtime.lease#claude",
            "sh.mschf.ratking.runtime.lease#codex",
            "sh.mschf.ratking.runtime.lease#opencode",
            "sh.mschf.ratking.runtime.lease#other"
          ].includes(value.$type),
          { expected: "unknown union tag only" }
        )
      )
    ]),
    leaseId: Schema21.optionalKey(
      lexString({ format: "tid", type: "string" }).pipe(
        Schema21.brand("Lexicon:tid")
      )
    ),
    renders: Schema21.optionalKey(
      Schema21.Array(lexString({ type: "string" })).check(
        Schema21.isMinLength(0),
        Schema21.isMaxLength(9007199254740991)
      )
    )
  }),
  [Schema21.Record(Schema21.String, Data)]
);
var Output10 = Schema21.StructWithRest(
  Schema21.Struct({ lease: Main4 }),
  [Schema21.Record(Schema21.String, Data)]
);
var ErrorBody10 = XrpcErrorBody;
var Method10 = {
  defaults: {},
  error: ErrorBody10,
  input: Input10,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.runtime.acquireLease",
  output: Output10,
  outputEncoding: "application/json",
  params: Params11,
  path: "/xrpc/sh.mschf.ratking.runtime.acquireLease"
};

// packages/lexicon/src/runtime.releaseLease.ts
import { Schema as Schema22 } from "effect";
var Params12 = Schema22.Undefined;
var Input11 = Schema22.StructWithRest(
  Schema22.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema22.brand("Lexicon:did")
    ),
    generation: Schema22.Int.check(
      Schema22.isGreaterThanOrEqualTo(1),
      Schema22.isLessThanOrEqualTo(9007199254740991)
    ),
    leaseId: lexString({ format: "tid", type: "string" }).pipe(
      Schema22.brand("Lexicon:tid")
    )
  }),
  [Schema22.Record(Schema22.String, Data)]
);
var Output11 = Schema22.Undefined;
var ErrorBody11 = XrpcErrorBody;
var Method11 = {
  defaults: {},
  error: ErrorBody11,
  input: Input11,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.runtime.releaseLease",
  output: Output11,
  outputEncoding: "",
  params: Params12,
  path: "/xrpc/sh.mschf.ratking.runtime.releaseLease"
};

// packages/lexicon/src/runtime.renewLease.ts
import { Schema as Schema23 } from "effect";
var Params13 = Schema23.Undefined;
var Input12 = Schema23.StructWithRest(
  Schema23.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema23.brand("Lexicon:did")
    ),
    expiresAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema23.brand("Lexicon:datetime")
    ),
    generation: Schema23.Int.check(
      Schema23.isGreaterThanOrEqualTo(1),
      Schema23.isLessThanOrEqualTo(9007199254740991)
    ),
    leaseId: lexString({ format: "tid", type: "string" }).pipe(
      Schema23.brand("Lexicon:tid")
    ),
    renders: Schema23.optionalKey(
      Schema23.Array(lexString({ type: "string" })).check(
        Schema23.isMinLength(0),
        Schema23.isMaxLength(9007199254740991)
      )
    )
  }),
  [Schema23.Record(Schema23.String, Data)]
);
var Output12 = Schema23.StructWithRest(
  Schema23.Struct({ lease: Main4 }),
  [Schema23.Record(Schema23.String, Data)]
);
var ErrorBody12 = XrpcErrorBody;
var Method12 = {
  defaults: {},
  error: ErrorBody12,
  input: Input12,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.runtime.renewLease",
  output: Output12,
  outputEncoding: "application/json",
  params: Params13,
  path: "/xrpc/sh.mschf.ratking.runtime.renewLease"
};

// packages/lexicon/src/runtime.resolveLease.ts
import { Effect as Effect9, Schema as Schema24 } from "effect";
var Params14 = Schema24.StructWithRest(
  Schema24.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema24.brand("Lexicon:did")
    )
  }),
  [Schema24.Record(Schema24.String, Data)]
);
var Input13 = Schema24.Undefined;
var Output13 = Schema24.StructWithRest(
  Schema24.Struct({ lease: Main4 }),
  [Schema24.Record(Schema24.String, Data)]
);
var ParamsFromQuery4 = Schema24.StructWithRest(
  Schema24.Struct({ did: Schema24.String }),
  [Schema24.Record(Schema24.String, Data)]
).pipe(Schema24.decodeTo(Params14));
var encodeParams7 = Effect9.fn("lexicon.encodeParams")(
  function* encodeParams8(params) {
    return entries(
      yield* Schema24.decodeUnknownEffect(Params2)(
        yield* Schema24.encodeEffect(ParamsFromQuery4)(params)
      )
    );
  }
);
var decodeParams7 = Effect9.fn("lexicon.decodeParams")(
  function* decodeParams8(entries2) {
    return yield* Schema24.decodeUnknownEffect(ParamsFromQuery4)(
      parameters(entries2)
    );
  }
);
var ErrorBody13 = XrpcErrorBody;
var Method13 = {
  defaults: {},
  error: ErrorBody13,
  input: Input13,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.runtime.resolveLease",
  output: Output13,
  outputEncoding: "application/json",
  params: Params14,
  path: "/xrpc/sh.mschf.ratking.runtime.resolveLease"
};

// packages/lexicon/src/transport.ts
import { Context } from "effect";
var Transport = class extends Context.Service()("@rat-king/lexicon/Transport") {
};

// packages/lexicon/src/xrpc-failure.ts
import { Schema as Schema25 } from "effect";
var XrpcFailure = class extends Schema25.TaggedError()(
  "XrpcFailure",
  {
    error: Schema25.String,
    message: Schema25.optionalKey(Schema25.String),
    response: Schema25.Union([Schema25.String, DataMap]),
    status: Schema25.Int
  }
) {
};

// packages/lexicon/src/mailbox-client.ts
var responseBody = Effect10.fn("lexicon.responseBody")(function* responseBody2(response) {
  if (response.kind !== "json") {
    return yield* new XrpcFailure({
      error: "NonJsonResponse",
      response: response.body,
      status: response.status
    });
  }
  if (response.status < 200 || response.status >= 300) {
    const result = yield* Schema26.decodeUnknownEffect(XrpcErrorBody)(
      response.body
    ).pipe(Effect10.result);
    if (Result.isSuccess(result)) {
      return yield* new XrpcFailure({
        error: result.success.error,
        status: response.status,
        ...result.success.message === void 0 ? { response: result.success } : { message: result.success.message, response: result.success }
      });
    }
    return yield* new XrpcFailure({
      error: "InvalidErrorResponse",
      response: { body: response.body },
      status: response.status
    });
  }
  return response.body;
});
var MailboxClient = class extends Context2.Service()("@rat-king/lexicon/MailboxClient") {
};
var clientLayer = Layer.effect(
  MailboxClient,
  Effect10.gen(function* clientLayer2() {
    const transport = yield* Transport;
    return MailboxClient.of({
      ack: Effect10.fn("lexicon.ack")(function* invoke(input) {
        const body = yield* Schema26.encodeEffect(Input6)(input);
        const response = yield* transport.request({
          input: body,
          method: Method6.method,
          nsid: Method6.nsid,
          params: void 0
        });
        return yield* Schema26.decodeUnknownEffect(Output6)(
          yield* responseBody(response)
        );
      }),
      acquireLease: Effect10.fn("lexicon.acquireLease")(function* invoke(input) {
        const encoded = yield* Schema26.encodeEffect(Input10)(input);
        const response = yield* transport.request({
          input: encoded,
          method: Method10.method,
          nsid: Method10.nsid,
          params: void 0
        });
        return yield* Schema26.decodeUnknownEffect(Output10)(
          yield* responseBody(response)
        );
      }),
      deliver: Effect10.fn("lexicon.deliver")(function* invoke(input) {
        const encoded = yield* Schema26.encodeEffect(Input7)(input);
        const response = yield* transport.request({
          input: encoded,
          method: Method7.method,
          nsid: Method7.nsid,
          params: void 0
        });
        return yield* Schema26.decodeUnknownEffect(Output7)(
          yield* responseBody(response)
        );
      }),
      getPreferences: Effect10.fn("lexicon.getPreferences")(
        function* invoke(params) {
          const encoded = yield* Schema26.encodeEffect(Params3)(
            params
          );
          const response = yield* transport.request({
            input: void 0,
            method: Method2.method,
            nsid: Method2.nsid,
            params: encoded
          });
          return yield* Schema26.decodeUnknownEffect(Output2)(
            yield* responseBody(response)
          );
        }
      ),
      getStatus: Effect10.fn("lexicon.getStatus")(function* invoke(params) {
        const encoded = yield* Schema26.encodeEffect(Params4)(params);
        const response = yield* transport.request({
          input: void 0,
          method: Method3.method,
          nsid: Method3.nsid,
          params: encoded
        });
        return yield* Schema26.decodeUnknownEffect(Output3)(
          yield* responseBody(response)
        );
      }),
      list: Effect10.fn("lexicon.list")(function* invoke(params) {
        const encoded = yield* Schema26.encodeEffect(Params9)({
          ...Method8.defaults,
          ...params
        });
        const response = yield* transport.request({
          input: void 0,
          method: Method8.method,
          nsid: Method8.nsid,
          params: encoded
        });
        return yield* Schema26.decodeUnknownEffect(Output8)(
          yield* responseBody(response)
        );
      }),
      putDidDocument: Effect10.fn("lexicon.putDidDocument")(
        function* invoke(input) {
          const encoded = yield* Schema26.encodeEffect(Input)(
            input
          );
          const response = yield* transport.request({
            input: encoded,
            method: Method.method,
            nsid: Method.nsid,
            params: void 0
          });
          return yield* Schema26.decodeUnknownEffect(Output)(
            yield* responseBody(response)
          );
        }
      ),
      putPreferences: Effect10.fn("lexicon.putPreferences")(
        function* invoke(input) {
          const encoded = yield* Schema26.encodeEffect(Input4)(
            input
          );
          const response = yield* transport.request({
            input: encoded,
            method: Method4.method,
            nsid: Method4.nsid,
            params: void 0
          });
          return yield* Schema26.decodeUnknownEffect(Output4)(
            yield* responseBody(response)
          );
        }
      ),
      putStatus: Effect10.fn("lexicon.putStatus")(function* invoke(input) {
        const encoded = yield* Schema26.encodeEffect(Input5)(input);
        const response = yield* transport.request({
          input: encoded,
          method: Method5.method,
          nsid: Method5.nsid,
          params: void 0
        });
        return yield* Schema26.decodeUnknownEffect(Output5)(
          yield* responseBody(response)
        );
      }),
      releaseLease: Effect10.fn("lexicon.releaseLease")(function* invoke(input) {
        const encoded = yield* Schema26.encodeEffect(Input11)(input);
        const response = yield* transport.request({
          input: encoded,
          method: Method11.method,
          nsid: Method11.nsid,
          params: void 0
        });
        if (response.status === 204 && response.kind === "text" && response.body === "") {
          const output = void 0;
          return yield* Schema26.decodeEffect(Output11)(output);
        }
        return yield* Schema26.decodeUnknownEffect(Output11)(
          yield* responseBody(response)
        );
      }),
      renewLease: Effect10.fn("lexicon.renewLease")(function* invoke(input) {
        const encoded = yield* Schema26.encodeEffect(Input12)(input);
        const response = yield* transport.request({
          input: encoded,
          method: Method12.method,
          nsid: Method12.nsid,
          params: void 0
        });
        return yield* Schema26.decodeUnknownEffect(Output12)(
          yield* responseBody(response)
        );
      }),
      resolveLease: Effect10.fn("lexicon.resolveLease")(function* invoke(params) {
        const encoded = yield* Schema26.encodeEffect(Params14)({
          ...Method13.defaults,
          ...params
        });
        const response = yield* transport.request({
          input: void 0,
          method: Method13.method,
          nsid: Method13.nsid,
          params: encoded
        });
        return yield* Schema26.decodeUnknownEffect(Output13)(
          yield* responseBody(response)
        );
      }),
      send: Effect10.fn("lexicon.send")(function* invoke(input) {
        const body = yield* Schema26.encodeEffect(Input9)(input);
        const response = yield* transport.request({
          input: body,
          method: Method9.method,
          nsid: Method9.nsid,
          params: void 0
        });
        return yield* Schema26.decodeUnknownEffect(Output9)(
          yield* responseBody(response)
        );
      })
    });
  })
);

// packages/lexicon/passes.ts
import { encode as encode4 } from "@ipld/dag-cbor";
import { Effect as Effect16, Schema as Schema33 } from "effect";

// packages/lexicon/did-key.ts
import { Effect as Effect11, Result as Result2 } from "effect";
import * as Base64Url from "effect/encoding/Base64Url";

// packages/lexicon/trust-failure.ts
import { Schema as Schema27 } from "effect";
var TrustFailure = class extends Schema27.TaggedError()(
  "TrustFailure",
  { reason: Schema27.String }
) {
};

// packages/lexicon/pass-failure.ts
var refusal = (what, why, next) => new TrustFailure({ reason: `${what}; ${why}; ${next}` });

// packages/lexicon/did-key.ts
var alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
var prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
var curveB = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
var mod = (value) => (value % prime + prime) % prime;
var power = (base, exponent) => {
  let result = 1n;
  let current = mod(base);
  let remaining3 = exponent;
  while (remaining3 > 0n) {
    if (remaining3 % 2n === 1n) {
      result = mod(result * current);
    }
    current = mod(current * current);
    remaining3 /= 2n;
  }
  return result;
};
var coordinate2 = (value) => {
  const hex = value.toString(16).padStart(64, "0");
  return Base64Url.encode(
    Uint8Array.from(
      { length: 32 },
      (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    )
  );
};
var decode3 = (did) => {
  if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]{48}$/u.test(did)) {
    throw new Error("not a canonical P-256 did:key");
  }
  let value = 0n;
  for (const char of did.slice(9)) {
    value = value * 58n + BigInt(alphabet.indexOf(char));
  }
  const hex = value.toString(16);
  if (hex.length !== 70 || !hex.startsWith("8024")) {
    throw new Error("not the P-256 multicodec");
  }
  const prefix = Number.parseInt(hex.slice(4, 6), 16);
  const x = BigInt(`0x${hex.slice(6)}`);
  if (prefix !== 2 && prefix !== 3 || x >= prime) {
    throw new Error("invalid compressed P-256 point");
  }
  const square = mod(x * x * x - 3n * x + curveB);
  const root = power(square, (prime + 1n) / 4n);
  if (mod(root * root) !== square) {
    throw new Error("point is not on P-256");
  }
  const y = Number(root % 2n) === prefix % 2 ? root : prime - root;
  return { crv: "P-256", kty: "EC", x: coordinate2(x), y: coordinate2(y) };
};
var decodeDidKey = (did) => Effect11.try({
  catch: () => refusal(
    "Key refused",
    "expected a canonical P-256 did:key",
    "generate a P-256 worker key and use its multibase DID"
  ),
  try: () => decode3(did)
});

// packages/lexicon/nonce-binding.ts
import { Clock, Context as Context3, Effect as Effect12 } from "effect";
var NonceBinding = class extends Context3.Service()("ratking/NonceBinding") {
};
var makeMemoryNonceBinding = (now = Clock.currentTimeMillis.pipe(Effect12.map((ms) => ms / 1e3))) => Effect12.sync(() => {
  const bindings = /* @__PURE__ */ new Map();
  return NonceBinding.of({
    bind: Effect12.fn("NonceBinding.bind")(
      function* bindNonce(deskDid, nonce, identity, until) {
        const current = yield* now;
        if (!Number.isFinite(current) || !Number.isFinite(until) || until < current) {
          return yield* refusal(
            "Nonce refused",
            "binding retention has expired",
            "obtain a fresh pass"
          );
        }
        const key = JSON.stringify([deskDid, nonce]);
        const prior = bindings.get(key);
        if (prior !== void 0 && prior.until >= current && (prior.identity.run !== identity.run || prior.identity.workerThumbprint !== identity.workerThumbprint)) {
          return "conflict";
        }
        bindings.set(key, {
          identity: { ...identity },
          until: Math.max(until, prior?.until ?? until)
        });
        return prior !== void 0 && prior.until >= current ? "match" : "new";
      }
    )
  });
});

// packages/lexicon/run-binding.ts
import { Context as Context4, Effect as Effect13 } from "effect";
var RunBinding = class extends Context4.Service()("ratking/RunBinding") {
};

// packages/lexicon/pass-scope.ts
import { Effect as Effect14 } from "effect";
var entry = /^(?<method>[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+)(?::(?<pattern>[^:*\s]+(?:\/\*)?))?$/u;
var parse = (value) => {
  const match = entry.exec(value);
  if (match?.groups === void 0) {
    return null;
  }
  return { method: match.groups.method ?? "", pattern: match.groups.pattern };
};
var covers = (requested, granted) => {
  const child = parse(requested);
  const parent = parse(granted);
  if (child === null || parent === null || child.method !== parent.method) {
    return false;
  }
  if (parent.pattern === void 0) {
    return true;
  }
  if (child.pattern === void 0) {
    return false;
  }
  return parent.pattern === child.pattern || parent.pattern.endsWith("/*") && child.pattern.startsWith(parent.pattern.slice(0, -1));
};
var scopeWithin = (passScope, issuerScope) => Effect14.suspend(() => {
  if (passScope.length === 0 || issuerScope.some((scope) => parse(scope) === null) || passScope.some(
    (scope) => !issuerScope.some((grant) => covers(scope, grant))
  )) {
    return Effect14.fail(
      refusal(
        "Scope refused",
        "empty, invalid or wider than the issuer scope",
        "request a narrower supported scope"
      )
    );
  }
  return Effect14.void;
});
var grantableScope = (scopes, grantable) => scopeWithin(scopes, scopes).pipe(
  Effect14.flatMap(() => {
    if (scopes.some((scope) => {
      const parsed = parse(scope);
      return parsed === null || !grantable.has(parsed.method);
    })) {
      return Effect14.fail(
        refusal(
          "Scope refused",
          "method is not grantable",
          "request a supported worker method"
        )
      );
    }
    return Effect14.void;
  })
);

// packages/lexicon/src/edge.ticket.ts
import { Schema as Schema28 } from "effect";
var Main5 = Schema28.StructWithRest(
  Schema28.Struct({
    $type: Schema28.Literal("sh.ratking.ticket"),
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema28.brand("Lexicon:did")
    ),
    exp: Schema28.Int.check(
      Schema28.isGreaterThanOrEqualTo(0),
      Schema28.isLessThanOrEqualTo(9007199254740991)
    ),
    fingerprint: lexString({
      maxLength: 64,
      minLength: 64,
      type: "string"
    }).check(Schema28.isPattern(/^[0-9a-f]{64}$/u)),
    iat: Schema28.Int.check(
      Schema28.isGreaterThanOrEqualTo(0),
      Schema28.isLessThanOrEqualTo(9007199254740991)
    ),
    issuer: lexString({ maxLength: 512, minLength: 1, type: "string" }),
    name: lexString({ maxLength: 256, minLength: 1, type: "string" }),
    namespace: lexString({
      maxLength: 256,
      minLength: 1,
      type: "string"
    })
  }),
  [Schema28.Record(Schema28.String, Data)]
);

// packages/lexicon/trust-signatures.ts
import { Context as Context5 } from "effect";
var Signatures = class extends Context5.Service()("ratking/Signatures") {
};

// packages/lexicon/trust.ts
import { encode as encode3 } from "@ipld/dag-cbor";
import { DateTime, Effect as Effect15, Schema as Schema32 } from "effect";

// packages/lexicon/src/edge.identity.ts
import { Schema as Schema29 } from "effect";
var PublicKey = Schema29.StructWithRest(
  Schema29.Struct({
    crv: lexString({ const: "P-256", type: "string" }).pipe(
      Schema29.decodeTo(Schema29.Literal("P-256"))
    ),
    kty: lexString({ const: "EC", type: "string" }).pipe(
      Schema29.decodeTo(Schema29.Literal("EC"))
    ),
    x: lexString({
      maxLength: 43,
      minLength: 43,
      type: "string"
    }).check(Schema29.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
    y: lexString({
      maxLength: 43,
      minLength: 43,
      type: "string"
    }).check(Schema29.isPattern(/^[A-Za-z0-9_-]{43}$/u))
  }),
  [Schema29.Record(Schema29.String, Data)]
);
var Main6 = Schema29.StructWithRest(
  Schema29.Struct({
    $type: Schema29.Literal("sh.ratking.identity"),
    atprotoHandle: lexString({ format: "handle", type: "string" }).pipe(
      Schema29.brand("Lexicon:handle")
    ),
    audience: lexString({
      const: "https://ratking.sh/mcp",
      type: "string"
    }).pipe(Schema29.decodeTo(Schema29.Literal("https://ratking.sh/mcp"))),
    createdAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema29.brand("Lexicon:datetime")
    ),
    expiresAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema29.brand("Lexicon:datetime")
    ),
    handle: lexString({ maxLength: 256, type: "string" }).check(
      Schema29.isPattern(/^ext\/[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/u)
    ),
    publicKey: PublicKey,
    subject: lexString({ format: "did", type: "string" }).pipe(
      Schema29.brand("Lexicon:did")
    )
  }),
  [Schema29.Record(Schema29.String, Data)]
);

// packages/lexicon/src/edge.invite.ts
import { Schema as Schema30 } from "effect";
var Main7 = Schema30.StructWithRest(
  Schema30.Struct({
    $type: Schema30.Literal("sh.ratking.invite"),
    allowFleetOutbound: Schema30.Boolean,
    createdAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema30.brand("Lexicon:datetime")
    ),
    expiresAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema30.brand("Lexicon:datetime")
    ),
    issuer: lexString({ format: "did", type: "string" }).pipe(
      Schema30.brand("Lexicon:did")
    ),
    namespace: lexString({
      maxLength: 128,
      minLength: 5,
      type: "string"
    }).check(Schema30.isPattern(/^ext\/[a-z0-9][a-z0-9_-]*\/$/u)),
    ratePerMinute: Schema30.Int.check(
      Schema30.isGreaterThanOrEqualTo(1),
      Schema30.isLessThanOrEqualTo(120)
    ),
    recipients: Schema30.Array(
      lexString({ maxLength: 256, minLength: 1, type: "string" })
    ).check(Schema30.isMinLength(1), Schema30.isMaxLength(64)),
    subject: lexString({ format: "did", type: "string" }).pipe(
      Schema30.brand("Lexicon:did")
    ),
    subjectKey: lexString({
      maxLength: 64,
      minLength: 64,
      type: "string"
    }).check(Schema30.isPattern(/^[a-f0-9]{64}$/u))
  }),
  [Schema30.Record(Schema30.String, Data)]
);

// packages/lexicon/src/edge.revocation.ts
import { Schema as Schema31 } from "effect";
var Main8 = Schema31.StructWithRest(
  Schema31.Struct({
    $type: Schema31.Literal("sh.ratking.revocation"),
    createdAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema31.brand("Lexicon:datetime")
    ),
    invite: lexString({
      maxLength: 64,
      minLength: 64,
      type: "string"
    }).check(Schema31.isPattern(/^[a-f0-9]{64}$/u)),
    issuer: lexString({ format: "did", type: "string" }).pipe(
      Schema31.brand("Lexicon:did")
    )
  }),
  [Schema31.Record(Schema31.String, Data)]
);

// packages/lexicon/trust-authority.ts
import { Context as Context6 } from "effect";
var TrustAuthority = class extends Context6.Service()("ratking/TrustAuthority") {
};

// packages/lexicon/trust.ts
var coordinate3 = Schema32.String.check(
  Schema32.isPattern(/^[A-Za-z0-9_-]{43}$/u)
);
var PublicKey2 = Schema32.Struct({
  crv: Schema32.Literal("P-256"),
  kty: Schema32.Literal("EC"),
  x: coordinate3,
  y: coordinate3
});
var signature = Schema32.String.check(Schema32.isPattern(/^[A-Za-z0-9_-]{86}$/u));
var keyId = Schema32.String.check(
  Schema32.isMinLength(1),
  Schema32.isMaxLength(512)
);
var SignedInvite = Schema32.Struct({
  keyId,
  record: Main7,
  signature
});
var SignedRevocation = Schema32.Struct({
  keyId,
  record: Main8,
  signature
});
var Identity = Main6;
var Credential = Schema32.Struct({
  identity: Schema32.Struct({ keyId, record: Identity, signature }),
  invite: Schema32.optionalKey(SignedInvite)
});
var Tier = Schema32.Literals([0, 1, 2, 3, 4]);
var TierDescription = Schema32.Struct({
  name: Schema32.String,
  proves: Schema32.String,
  tier: Tier
});
var signingBytes2 = (record, signingKeyId) => encode3({ domain: "sh.ratking.record.v1", keyId: signingKeyId, record });
var fingerprintBytes = (key) => encode3({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
var epoch = (value) => Schema32.decodeUnknownEffect(Schema32.DateTimeUtcFromString)(value).pipe(
  Effect15.map(DateTime.toEpochMillis),
  Effect15.mapError(() => new TrustFailure({ reason: "Invalid record time" }))
);
var lifetime = Effect15.fn("Trust.lifetime")(function* checkLifetime(createdAt, expiresAt, now) {
  const created = yield* epoch(createdAt);
  const expires = yield* epoch(expiresAt);
  if (created > now || expires <= now || expires <= created) {
    return yield* new TrustFailure({ reason: "Record is not currently valid" });
  }
  return expires;
});
var verifyIssued = Effect15.fn("Trust.verifyIssued")(
  function* verifyIssuedRecord(record, issuer, signingKeyId, signed) {
    if (!signingKeyId.startsWith(`${issuer}#`)) {
      return yield* new TrustFailure({
        reason: "Signing key does not belong to issuer"
      });
    }
    const authority = yield* TrustAuthority;
    const allowed = yield* authority.issuer(issuer, signingKeyId);
    const crypto2 = yield* Signatures;
    if (!(yield* crypto2.verify(
      allowed.key,
      signingBytes2(record, signingKeyId),
      signed
    ))) {
      return yield* new TrustFailure({ reason: "Invalid record signature" });
    }
    return allowed;
  }
);
var InviteScope = Schema32.Struct({
  handle: Identity.schema.fields.handle,
  recipient: Schema32.String.check(
    Schema32.isMinLength(1),
    Schema32.isMaxLength(256)
  ),
  subject: Identity.schema.fields.subject,
  subjectKey: Main7.schema.fields.subjectKey
});
var VerifiedInvite = Schema32.Struct({
  allowFleetOutbound: Schema32.Boolean,
  expiresAt: Schema32.String,
  fingerprint: Schema32.String,
  namespace: Schema32.String,
  ratePerMinute: Schema32.Int,
  recipients: Schema32.Array(Schema32.String),
  tier: Schema32.Literal(3)
});
var verifyInvite = Effect15.fn("Trust.verifyInvite")(
  function* verifyInviteRecord(signed, scope, now) {
    const { record } = signed;
    const grant = yield* verifyIssued(
      record,
      record.issuer,
      signed.keyId,
      signed.signature
    );
    yield* lifetime(record.createdAt, record.expiresAt, now);
    if (!grant.namespaces.includes(record.namespace) || !scope.handle.startsWith(record.namespace) || scope.subject !== record.subject || scope.subjectKey !== record.subjectKey || !record.recipients.includes(scope.recipient)) {
      return yield* new TrustFailure({
        reason: "Invite is outside the requested scope"
      });
    }
    const crypto2 = yield* Signatures;
    const fingerprint = yield* crypto2.digest(
      signingBytes2(record, signed.keyId)
    );
    const authority = yield* TrustAuthority;
    for (const revoked of yield* authority.revocations(record.issuer)) {
      yield* verifyIssued(
        revoked.record,
        revoked.record.issuer,
        revoked.keyId,
        revoked.signature
      );
      if (revoked.record.issuer !== record.issuer || (yield* epoch(revoked.record.createdAt)) > now) {
        return yield* new TrustFailure({
          reason: "Invalid revocation snapshot"
        });
      }
      if (revoked.record.invite === fingerprint) {
        return yield* new TrustFailure({ reason: "Invite has been revoked" });
      }
    }
    return VerifiedInvite.make({
      allowFleetOutbound: record.allowFleetOutbound,
      expiresAt: record.expiresAt,
      fingerprint,
      namespace: record.namespace,
      ratePerMinute: record.ratePerMinute,
      recipients: record.recipients,
      tier: 3
    });
  }
);
var TrustResult = Schema32.Struct({
  fingerprint: Schema32.NullOr(Schema32.String),
  handle: Schema32.NullOr(Schema32.String),
  invite: Schema32.NullOr(VerifiedInvite),
  subject: Schema32.NullOr(Schema32.String),
  tier: Tier
});
var stranger = TrustResult.make({
  fingerprint: null,
  handle: null,
  invite: null,
  subject: null,
  tier: 0
});
var whoami = Effect15.fn("Trust.whoami")(function* inspectIdentity(credential, recipient, now) {
  if (credential === void 0) {
    return stranger;
  }
  const { identity } = credential;
  const { record } = identity;
  yield* lifetime(record.createdAt, record.expiresAt, now);
  if ((yield* epoch(record.expiresAt)) - (yield* epoch(record.createdAt)) > 3e5) {
    return yield* new TrustFailure({
      reason: "Identity credential exceeds five minutes"
    });
  }
  const crypto2 = yield* Signatures;
  if (!(yield* crypto2.verify(
    record.publicKey,
    signingBytes2(record, identity.keyId),
    identity.signature
  ))) {
    return yield* new TrustFailure({ reason: "Invalid identity signature" });
  }
  const fingerprint = yield* crypto2.digest(fingerprintBytes(record.publicKey));
  const authority = yield* TrustAuthority;
  const attestation = yield* authority.identity(identity.keyId);
  const attested = attestation !== void 0 && attestation.subject === record.subject && attestation.handle === record.handle && attestation.atprotoHandle === record.atprotoHandle && attestation.fingerprint === fingerprint;
  const invite = credential.invite === void 0 ? null : yield* verifyInvite(
    credential.invite,
    {
      handle: record.handle,
      recipient,
      subject: record.subject,
      subjectKey: fingerprint
    },
    now
  );
  let tier = attested ? attestation.tier : 1;
  if (invite !== null && tier !== 4) {
    tier = 3;
  }
  return TrustResult.make({
    fingerprint,
    handle: record.handle,
    invite,
    subject: attested ? record.subject : null,
    tier
  });
});

// packages/lexicon/passes.ts
var signature2 = Schema33.String.check(Schema33.isPattern(/^[A-Za-z0-9_-]{86}$/u));
var SignedTicket = Schema33.Struct({
  publicKey: PublicKey2,
  record: Main5,
  signature: signature2
});
var SignedPass2 = Schema33.Struct({ record: Main, signature: signature2 });
var decode4 = (schema, input) => Schema33.decodeUnknownEffect(schema)(input).pipe(
  Effect16.mapError(
    () => refusal(
      "Record refused",
      "record does not match its schema",
      "provide a valid signed ticket or pass"
    )
  )
);
var bytes = (record) => Effect16.try({
  catch: () => refusal(
    "Record refused",
    "record cannot be encoded as DAG-CBOR",
    "provide a canonical lexicon record"
  ),
  try: () => encode4({ domain: "sh.ratking.delegation.v1", record })
});
var lifetime2 = (iat, exp, now, cap) => {
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || !Number.isFinite(now) || exp <= iat || exp - iat > cap || now < iat - 60 || now > exp + 60) {
    return Effect16.fail(
      refusal(
        "Lifetime refused",
        "record is outside its lifetime or exceeds its cap",
        "obtain a fresh short-lived ticket or pass"
      )
    );
  }
  return Effect16.void;
};
var verify3 = Effect16.fn("Passes.verifySignature")(function* verifySignature(key, record, signed) {
  const crypto2 = yield* Signatures;
  if (!(yield* crypto2.verify(key, yield* bytes(record), signed))) {
    return yield* refusal(
      "Signature refused",
      "signature does not match the authorized key",
      "sign with the correct issuer or desk key"
    );
  }
  return yield* Effect16.void;
});
var cryptoErrors = (effect) => effect.pipe(
  Effect16.mapError(
    (failure3) => failure3.reason.split(";").length === 3 ? failure3 : refusal(
      "Cryptography refused",
      "key or signature operation failed",
      "check the P-256 key and signed bytes"
    )
  )
);
var signTicket = Effect16.fn("Passes.signTicket")(
  function* signTicketRecord(issuerKey, input, deskKey) {
    const record = yield* decode4(Main5, input);
    const publicKey = deskKey === void 0 ? yield* decodeDidKey(record.did) : yield* decode4(PublicKey2, deskKey);
    return {
      publicKey,
      record,
      signature: yield* issuerKey.sign(yield* bytes(record))
    };
  },
  cryptoErrors
);
var signPass = Effect16.fn("Passes.signPass")(function* signPassRecord(deskKey, input) {
  const record = yield* decode4(Main, input);
  return { record, signature: yield* deskKey.sign(yield* bytes(record)) };
}, cryptoErrors);
var checkDidKey = Effect16.fn("Passes.checkDidKey")(function* checkDidKey2(did, key) {
  if (!/^[AEIMQUYcgkosw048]$/u.test(key.x.slice(-1)) || !/^[AEIMQUYcgkosw048]$/u.test(key.y.slice(-1))) {
    return yield* refusal(
      "Desk refused",
      "public key coordinates are not canonical base64url",
      "use the canonical P-256 public key"
    );
  }
  if (did.startsWith("did:key:")) {
    const decoded = yield* decodeDidKey(did);
    if (decoded.x !== key.x || decoded.y !== key.y) {
      return yield* refusal(
        "Desk refused",
        "public key does not match the desk DID",
        "provide the desk's matching key"
      );
    }
  }
  return yield* Effect16.void;
});
var verifyTicket = Effect16.fn("Passes.verifyTicket")(
  function* verifyTicketRecord(pinnedIssuers, input, now) {
    const signed = yield* decode4(SignedTicket, input);
    const { record } = signed;
    const issuer = pinnedIssuers.get(record.issuer);
    if (issuer === void 0) {
      return yield* refusal(
        "Ticket refused",
        "issuer is not pinned",
        "obtain a ticket from a trusted host issuer"
      );
    }
    yield* lifetime2(record.iat, record.exp, now, 900);
    if (!new Set(issuer.namespaces).has(record.namespace) || !record.name.startsWith(
      record.namespace.endsWith("/") ? record.namespace : `${record.namespace}/`
    )) {
      return yield* refusal(
        "Ticket refused",
        "name is outside the issuer namespaces",
        "request a name within the pinned namespace"
      );
    }
    yield* verify3(issuer.key, record, signed.signature);
    const key = signed.publicKey;
    yield* checkDidKey(record.did, key);
    const crypto2 = yield* Signatures;
    if ((yield* crypto2.digest(fingerprintBytes(key))) !== record.fingerprint) {
      return yield* refusal(
        "Ticket refused",
        "fingerprint does not match the desk DID",
        "issue a ticket for the desk's actual public key"
      );
    }
    return { key, record };
  },
  cryptoErrors
);
var verified = /* @__PURE__ */ Symbol("VerifiedPass");
var deskAuthority = Effect16.fn("Passes.deskAuthority")(function* resolveDesk(authority, now) {
  if ("ticket" in authority) {
    const ticket = yield* verifyTicket(
      authority.pinnedIssuers,
      authority.ticket,
      now
    );
    return {
      did: ticket.record.did,
      key: ticket.key,
      name: ticket.record.name
    };
  }
  const { knownDesk } = authority;
  const key = yield* decode4(PublicKey2, knownDesk.key);
  yield* checkDidKey(knownDesk.did, key);
  return { ...knownDesk, key };
});
var verifyPass = Effect16.fn("Passes.verifyPass")(
  function* verifyPassRecord(authority, input, now) {
    const signed = yield* decode4(SignedPass2, input);
    const { record } = signed;
    const desk = yield* deskAuthority(authority, now);
    yield* lifetime2(record.iat, record.exp, now, 600);
    if (record.desk !== desk.name || record.deskDid !== desk.did || record.worker === record.deskDid) {
      return yield* refusal(
        "Pass refused",
        "desk binding is wrong or the worker borrowed the desk key",
        "issue a pass for a separate worker key from the correct desk"
      );
    }
    const workerKey = yield* decodeDidKey(record.worker);
    if (workerKey.x === desk.key.x && workerKey.y === desk.key.y) {
      return yield* refusal(
        "Pass refused",
        "worker key is the desk key under another DID",
        "generate a separate throwaway worker key"
      );
    }
    yield* grantableScope(record.scope, authority.grantable);
    yield* scopeWithin(record.scope, authority.issuerScope);
    yield* verify3(desk.key, record, signed.signature);
    const crypto2 = yield* Signatures;
    const nonces = yield* NonceBinding;
    const result = yield* nonces.bind(
      record.deskDid,
      record.nonce,
      {
        run: record.run,
        workerThumbprint: yield* crypto2.digest(fingerprintBytes(workerKey))
      },
      record.exp + 60
    );
    if (result === "conflict") {
      return yield* refusal(
        "Pass refused",
        "nonce is already bound to a different worker or run",
        "request a fresh nonce from the desk"
      );
    }
    return Object.freeze({
      [verified]: true,
      record: Object.freeze({
        ...record,
        scope: Object.freeze([...record.scope])
      }),
      workerKey: Object.freeze(workerKey)
    });
  },
  cryptoErrors
);
var verifyRequest = Effect16.fn("Passes.verifyRequest")(
  function* verifyWorkerRequest(pass, request, signed) {
    const crypto2 = yield* Signatures;
    if (!pass[verified] || !(yield* crypto2.verify(pass.workerKey, request, signed))) {
      return yield* refusal(
        "Request refused",
        "signature is not from the verified worker key",
        "sign the request with the worker's private key"
      );
    }
    return yield* Effect16.void;
  },
  cryptoErrors
);

// packages/lexicon/adapters/webcrypto.ts
import { Effect as Effect17, Layer as Layer2 } from "effect";
import * as Base64Url2 from "effect/encoding/Base64Url";
var cryptoFailure = () => new TrustFailure({ reason: "Cryptographic operation failed" });
var signatures = Layer2.succeed(
  Signatures,
  Signatures.of({
    digest: Effect17.fn("Signatures.digest")(function* digestBytes(bytes2) {
      const hash = yield* Effect17.tryPromise({
        catch: cryptoFailure,
        try: () => crypto.subtle.digest("SHA-256", Uint8Array.from(bytes2))
      });
      return Array.from(
        new Uint8Array(hash),
        (byte) => byte.toString(16).padStart(2, "0")
      ).join("");
    }),
    verify: Effect17.fn("Signatures.verify")(function* verifyBytes(key, bytes2, signature3) {
      const decoded = yield* Effect17.fromResult(
        Base64Url2.decode(signature3)
      ).pipe(Effect17.mapError(cryptoFailure));
      const imported = yield* Effect17.tryPromise({
        catch: cryptoFailure,
        try: () => crypto.subtle.importKey(
          "jwk",
          { crv: key.crv, kty: key.kty, x: key.x, y: key.y },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"]
        )
      });
      return yield* Effect17.tryPromise({
        catch: cryptoFailure,
        try: () => crypto.subtle.verify(
          { hash: "SHA-256", name: "ECDSA" },
          imported,
          Uint8Array.from(decoded),
          Uint8Array.from(bytes2)
        )
      });
    })
  })
);

// packages/mailbox-client/src/mailbox.ts
import { Clock as Clock5, Context as Context11, Effect as Effect28, Layer as Layer5, Option as Option4, Schema as Schema47 } from "effect";

// packages/mailbox-client/src/attention.ts
import { Effect as Effect18, Schema as Schema36 } from "effect";

// packages/mailbox-client/src/error.ts
import { Schema as Schema34 } from "effect";
var MailboxClientError = class extends Schema34.TaggedError()(
  "MailboxClientError",
  {
    error: Schema34.optionalKey(Schema34.String),
    reason: Schema34.String,
    status: Schema34.optionalKey(Schema34.Finite)
  }
) {
};
var clientError = (failure3) => {
  if (Schema34.is(MailboxClientError)(failure3)) {
    return failure3;
  }
  if (Schema34.is(XrpcFailure)(failure3)) {
    return new MailboxClientError({
      error: failure3.error,
      reason: failure3.message ?? "Mailbox XRPC call failed",
      status: failure3.status
    });
  }
  return new MailboxClientError({ reason: "Mailbox operation failed" });
};

// packages/mailbox-client/src/identity.ts
import { Schema as Schema35 } from "effect";
var PrivateJwk = Schema35.Struct({
  crv: Schema35.Literal("P-256"),
  d: Schema35.String,
  kty: Schema35.Literal("EC"),
  x: Schema35.String,
  y: Schema35.String
});
var Identity2 = Schema35.Struct({
  agreement: PrivateJwk,
  did: Schema35.String.check(Schema35.isPattern(/^did:web:/u)),
  signing: PrivateJwk
});
var importSigning = (identity) => cryptoOperation(
  () => crypto.subtle.importKey(
    "jwk",
    identity.signing,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )
);
var importAgreement = (identity) => cryptoOperation(
  () => crypto.subtle.importKey(
    "jwk",
    identity.agreement,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  )
);

// packages/mailbox-client/src/attention.ts
var attentionBytes = (did, nsid, value) => canonical({ did, nsid, value });
var attentionClient = (client, identity) => ({
  getPreferences: Effect18.fn("AttentionClient.getPreferences")(
    () => Schema36.decodeUnknownEffect(Params3)({
      did: identity.did
    }).pipe(
      Effect18.flatMap(client.getPreferences),
      Effect18.map((output) => output.prefs),
      Effect18.mapError(clientError)
    )
  ),
  getStatus: Effect18.fn("AttentionClient.getStatus")(
    (did = identity.did) => Schema36.decodeUnknownEffect(Params4)({ did }).pipe(
      Effect18.flatMap(client.getStatus),
      Effect18.map((output) => output.status),
      Effect18.mapError(clientError)
    )
  ),
  putPreferences: Effect18.fn("AttentionClient.putPreferences")(
    function* putPreferences(prefs) {
      const validated = yield* Schema36.decodeUnknownEffect(Main2)(prefs);
      const key = yield* importSigning(identity);
      const signature3 = yield* sign(
        key,
        attentionBytes(identity.did, Method4.nsid, validated)
      );
      const input = yield* Schema36.decodeUnknownEffect(
        Schema36.toType(Input4)
      )({
        did: identity.did,
        keyId: `${identity.did}#atproto`,
        prefs: validated,
        signature: signature3
      });
      return (yield* client.putPreferences(input)).prefs;
    },
    Effect18.mapError(clientError)
  ),
  putStatus: Effect18.fn("AttentionClient.putStatus")(function* putStatus(status) {
    const validated = yield* Schema36.decodeUnknownEffect(Main3)(status);
    const key = yield* importSigning(identity);
    const signature3 = yield* sign(
      key,
      attentionBytes(identity.did, Method5.nsid, validated)
    );
    const input = yield* Schema36.decodeUnknownEffect(
      Schema36.toType(Input5)
    )({
      did: identity.did,
      keyId: `${identity.did}#atproto`,
      signature: signature3,
      status: validated
    });
    return (yield* client.putStatus(input)).status;
  }, Effect18.mapError(clientError))
});
var defaultPreferences = () => Schema36.decodeUnknownSync(Main2)({
  allow: [],
  forward: [],
  log: false,
  model: { body: "summary", kind: "none", timeoutMs: 2e3 },
  mute: [],
  refuse: [],
  version: "0.1"
});
var defaultStatus = () => Schema36.decodeUnknownSync(Main3)({
  $type: "sh.mschf.ratking.attention.status",
  state: "available",
  version: "0.1"
});
var toBasisPoints = (decimal) => Math.round(decimal * 1e4);
var fromBasisPoints = (points) => points / 1e4;

// packages/mailbox-client/src/auth.ts
import { Context as Context8, Effect as Effect19, Layer as Layer3, Schema as Schema38 } from "effect";

// packages/mailbox-client/src/auth-failure.ts
import { Schema as Schema37 } from "effect";
var ServiceAuthFailure = class extends Schema37.TaggedError()(
  "XrpcFailure",
  {
    error: Schema37.String,
    message: Schema37.optionalKey(Schema37.String),
    response: Schema37.Record(Schema37.String, Schema37.Json),
    status: Schema37.Int
  }
) {
};

// packages/mailbox-client/src/replay.ts
import { Context as Context7 } from "effect";
var ReplayAuthority = class extends Context7.Service()("mailbox/ReplayAuthority") {
};

// packages/mailbox-client/src/auth.ts
var failure = (error, status, message) => {
  if (message === void 0) {
    return new ServiceAuthFailure({ error, response: {}, status });
  }
  return new ServiceAuthFailure({ error, message, response: {}, status });
};
var base64url2 = (bytes2) => btoa(Array.from(bytes2, (byte) => String.fromCodePoint(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
var unbase64url = (text) => Uint8Array.from(
  atob(text.replaceAll("-", "+").replaceAll("_", "/")),
  (character) => character.codePointAt(0) ?? 0
);
var Claims = Schema38.Struct({
  aud: Schema38.String,
  exp: Schema38.Int,
  iat: Schema38.Int,
  iss: Schema38.String,
  jti: Schema38.String.check(Schema38.isMinLength(16)),
  lxm: Schema38.String
});
var authFailure = (error, status = 400, message = error) => new ServiceAuthFailure({
  error,
  message,
  response: { error, message },
  status
});
var PublicJwk2 = Schema38.Struct({
  crv: Schema38.Literal("P-256"),
  d: Schema38.optionalKey(Schema38.Never),
  kty: Schema38.Literal("EC"),
  x: Schema38.String,
  y: Schema38.String
});
var Document = Schema38.Struct({
  authentication: Schema38.Array(Schema38.String),
  id: Schema38.String,
  keyAgreement: Schema38.Array(Schema38.String),
  verificationMethod: Schema38.Array(
    Schema38.Struct({
      controller: Schema38.String,
      id: Schema38.String,
      publicKeyJwk: PublicJwk2
    })
  )
});
var Documents = Schema38.Array(Document);
var DidResolver = class extends Context8.Service()("mailbox/DidResolver") {
};
var documentResolver = (lookup) => Layer3.succeed(
  DidResolver,
  DidResolver.of({
    resolve: Effect19.fn("DidResolver.resolve")(
      function* resolve(did, keyId2, purpose) {
        const document = yield* lookup(did);
        const method = document?.verificationMethod.find(
          (candidate) => candidate.id === keyId2 && candidate.controller === did
        );
        if (!did.startsWith("did:web:") || !method || document?.[purpose].includes(keyId2) !== true) {
          return yield* Effect19.fail(
            failure("Forbidden", 403, "Unauthorized DID key")
          );
        }
        const algorithm = purpose === "authentication" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "ECDH", namedCurve: "P-256" };
        return yield* cryptoOperation(
          () => crypto.subtle.importKey(
            "jwk",
            method.publicKeyJwk,
            algorithm,
            true,
            purpose === "authentication" ? ["verify"] : []
          )
        ).pipe(Effect19.mapError(() => failure("AuthRequired", 401)));
      }
    )
  })
);
var staticResolver = (documents) => documentResolver(
  (did) => Effect19.succeed(documents.find((candidate) => candidate.id === did))
);
var Header = Schema38.Struct({
  alg: Schema38.Literal("ES256"),
  kid: Schema38.optionalKey(Schema38.String),
  typ: Schema38.optionalKey(Schema38.Literal("JWT"))
});
var json = (text) => Effect19.try({
  catch: () => authFailure("AuthRequired", 401),
  try: () => new TextDecoder().decode(unbase64url(text))
});
var authenticateClaims = Effect19.fn("ServiceAuth.authenticateClaims")(
  function* authenticateClaims2(request) {
    const token = request.authorization?.match(
      /^Bearer (?<token>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u
    )?.groups?.token;
    if (token === void 0 || token === "") {
      return yield* Effect19.fail(authFailure("AuthRequired", 401));
    }
    const [headerText = "", claimsText = "", signatureText = ""] = token.split(".");
    const header = yield* Schema38.decodeUnknownEffect(
      Schema38.fromJsonString(Header)
    )(yield* json(headerText)).pipe(
      Effect19.mapError(() => authFailure("AuthRequired", 401))
    );
    const claims = yield* Schema38.decodeUnknownEffect(
      Schema38.fromJsonString(Claims)
    )(yield* json(claimsText)).pipe(
      Effect19.mapError(() => authFailure("AuthRequired", 401))
    );
    const now = Math.floor(request.now / 1e3);
    if (claims.aud !== request.audience || claims.lxm !== request.nsid || claims.iat > now + (request.skewSeconds ?? 0) || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 60 || now - claims.iat > 60) {
      return yield* Effect19.fail(
        authFailure("AuthRequired", 401, "Invalid service-auth claims")
      );
    }
    const kid = header.kid ?? "#atproto";
    const keyId2 = kid.startsWith("#") ? `${claims.iss}${kid}` : kid;
    const resolver = yield* DidResolver;
    const key = yield* resolver.resolve(claims.iss, keyId2, "authentication");
    const signature3 = yield* Effect19.try({
      catch: () => authFailure("AuthRequired", 401),
      try: () => unbase64url(signatureText)
    });
    const valid = yield* verify(
      key,
      new TextEncoder().encode(`${headerText}.${claimsText}`),
      signature3
    ).pipe(Effect19.mapError(() => authFailure("AuthRequired", 401)));
    if (!valid) {
      return yield* Effect19.fail(authFailure("AuthRequired", 401));
    }
    const replay = yield* ReplayAuthority;
    yield* replay.consume(claims, request.now);
    return claims;
  }
);
var serviceToken = Effect19.fn("ServiceAuth.sign")(
  function* serviceToken2(claims, key, kid) {
    const header = base64url2(
      new TextEncoder().encode(
        JSON.stringify({ alg: "ES256", kid: kid ?? "#atproto", typ: "JWT" })
      )
    );
    const payload = base64url2(new TextEncoder().encode(JSON.stringify(claims)));
    const bytes2 = new TextEncoder().encode(`${header}.${payload}`);
    return `${header}.${payload}.${base64url2(yield* sign(key, bytes2))}`;
  }
);

// packages/mailbox-client/src/deadline.ts
import {
  Cause,
  Clock as Clock2,
  Context as Context9,
  Duration,
  Effect as Effect20,
  Option,
  Schedule
} from "effect";
var Deadline = Context9.Reference("RatKing/Deadline", {
  defaultValue: () => Number.POSITIVE_INFINITY
});
var REQUEST_MS = 1e4;
var OPERATION_MS = 9e4;
var LEASE_MS = 3e3;
var remaining = Effect20.gen(function* remaining2() {
  const at = yield* Deadline;
  return Math.max(0, at - (yield* Clock2.currentTimeMillis));
});
var canAttempt = (attemptMs, delayMs = 0) => remaining.pipe(Effect20.map((left) => left >= attemptMs + delayMs));
var retryBudget = (attemptMs) => (schedule) => schedule.pipe(
  Schedule.while(
    ({ duration }) => canAttempt(attemptMs, Duration.toMillis(duration))
  )
);
var timeoutOrElse = (options) => (effect) => Effect20.gen(function* withinDeadline() {
  const now = yield* Clock2.currentTimeMillis;
  const at = Math.min(
    yield* Deadline,
    now + Duration.toMillis(Duration.fromInputUnsafe(options.duration))
  );
  const left = at - now;
  if (left <= 0) {
    return yield* options.orElse();
  }
  return yield* effect.pipe(
    Effect20.provideService(Deadline, at),
    Effect20.timeoutOrElse({ duration: left, orElse: options.orElse })
  );
});
var timeout = (duration) => timeoutOrElse({
  duration,
  orElse: () => Effect20.fail(new Cause.TimeoutError("Mailbox deadline exceeded"))
});
var timeoutOption = (duration) => (effect) => effect.pipe(
  Effect20.map(Option.some),
  timeoutOrElse({
    duration,
    orElse: () => Effect20.succeed(Option.none())
  })
);

// packages/mailbox-client/src/delegation.ts
import { Effect as Effect22, Schema as Schema40 } from "effect";

// packages/mailbox-client/src/payload.ts
import { Effect as Effect21, Schema as Schema39 } from "effect";
var AgentName = Schema39.String.check(
  Schema39.isPattern(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9_-]{0,31}$/u)
);
var SUMMARY_MAX = 280;
var SUMMARY_HARD_MAX = 400;
var SUMMARY_WIRE_MAX = SUMMARY_MAX;
var Kind = Schema39.Literals(["message", "ask", "reply", "data"]);
var ReplyRef = Schema39.Struct({
  parent: Schema39.String,
  root: Schema39.String
});
var Payload = Schema39.Struct({
  body: Schema39.String,
  cc: Schema39.optionalKey(Schema39.Array(AgentName)),
  from: AgentName,
  kind: Schema39.optionalKey(Kind),
  label: Schema39.optionalKey(Schema39.String.check(Schema39.isMaxLength(256))),
  quiet: Schema39.optionalKey(Schema39.Literal(true)),
  reply: Schema39.optionalKey(ReplyRef),
  replyTo: Schema39.optionalKey(Schema39.String),
  summary: Schema39.optionalKey(
    Schema39.String.check(Schema39.isMaxLength(SUMMARY_HARD_MAX))
  ),
  thread: Schema39.optionalKey(Schema39.String),
  to: Schema39.optionalKey(AgentName)
});
var PayloadJson = Schema39.fromJsonString(Payload);
var encodePayload = Effect21.fn("RatKing.encodePayload")(
  function* encodePayload2(payload) {
    return yield* Schema39.encodeEffect(PayloadJson)(payload);
  }
);

// packages/mailbox-client/src/delegation.ts
var openDelegated = Effect22.fn("Mailbox.openDelegated")(
  function* openDelegated2(envelope, receipt, recipientDid, resolveSigningKey) {
    if (receipt.recipientDid !== recipientDid || receipt.originalId !== envelope.aad.messageId || receipt.message.messageId === receipt.originalId || receipt.message.senderDid !== envelope.aad.senderDid) {
      return yield* new EnvelopeFailure({
        reason: "Invalid delegated custody"
      });
    }
    const signed = yield* openPlaintext(envelope, resolveSigningKey);
    const payload = yield* Schema40.decodeUnknownEffect(PayloadJson)(
      new TextDecoder().decode(signed.body)
    );
    if (receipt.delegatedFor === void 0 || payload.to !== receipt.delegatedFor) {
      return yield* new EnvelopeFailure({
        reason: "Invalid delegated recipient"
      });
    }
    return signed;
  }
);

// packages/lexicon/src/mailbox.getPresence.ts
import { Effect as Effect23, Schema as Schema41 } from "effect";
var Params15 = Schema41.StructWithRest(
  Schema41.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema41.brand("Lexicon:did")
    )
  }),
  [Schema41.Record(Schema41.String, Data)]
);
var Input14 = Schema41.Undefined;
var Output14 = Schema41.StructWithRest(
  Schema41.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema41.brand("Lexicon:did")
    ),
    held: Schema41.Boolean,
    lastHeldAt: Schema41.optionalKey(
      lexString({ format: "datetime", type: "string" }).pipe(
        Schema41.brand("Lexicon:datetime")
      )
    ),
    renders: Schema41.optionalKey(
      Schema41.Array(lexString({ type: "string" })).check(
        Schema41.isMinLength(0),
        Schema41.isMaxLength(9007199254740991)
      )
    )
  }),
  [Schema41.Record(Schema41.String, Data)]
);
var ParamsFromQuery5 = Schema41.StructWithRest(
  Schema41.Struct({ did: Schema41.String }),
  [Schema41.Record(Schema41.String, Data)]
).pipe(Schema41.decodeTo(Params15));
var encodeParams9 = Effect23.fn("lexicon.encodeParams")(
  function* encodeParams10(params) {
    return entries(
      yield* Schema41.decodeUnknownEffect(Params2)(
        yield* Schema41.encodeEffect(ParamsFromQuery5)(params)
      )
    );
  }
);
var decodeParams9 = Effect23.fn("lexicon.decodeParams")(
  function* decodeParams10(entries2) {
    return yield* Schema41.decodeUnknownEffect(ParamsFromQuery5)(
      parameters(entries2)
    );
  }
);
var ErrorBody14 = XrpcErrorBody;
var Method14 = {
  defaults: {},
  error: ErrorBody14,
  input: Input14,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.mailbox.getPresence",
  output: Output14,
  outputEncoding: "application/json",
  params: Params15,
  path: "/xrpc/sh.mschf.ratking.mailbox.getPresence"
};

// packages/mailbox-client/src/record-visibility.ts
import { Effect as Effect24, Option as Option2, Schema as Schema42 } from "effect";
var readerCannotRender = (name, type, presence) => type !== "unknown" && presence?.held === true && presence.renders !== void 0 && !presence.renders.some(
  (render) => render.endsWith(".*") ? type.startsWith(render.slice(0, -1)) : type === render
) ? `NOT SENT: ReaderCannotRender. ${name}'s reader doesn't render ${type} (it predates typed records or doesn't declare it). Send prose instead, or ask them to restart.` : void 0;
var recordType = (body) => {
  const result = Schema42.decodeUnknownOption(
    Schema42.fromJsonString(Schema42.Struct({ $type: Schema42.String }))
  )(body);
  return Option2.match(result, {
    onNone: () => "unknown",
    onSome: (record) => record.$type
  });
};
var lookupPresence = Effect24.fn("Mailbox.lookupPresence")(
  function* lookupPresence2(did) {
    const transport = yield* Transport;
    const params = yield* Schema42.decodeUnknownEffect(Params15)({
      did
    }).pipe(Effect24.mapError(clientError));
    const response = yield* transport.request({
      input: void 0,
      method: "GET",
      nsid: Method14.nsid,
      params: yield* Schema42.encodeEffect(Params15)(params).pipe(
        Effect24.mapError(clientError)
      )
    }).pipe(Effect24.mapError(clientError));
    if (response.kind !== "json" || response.status !== 200) {
      return yield* new MailboxClientError({
        reason: "Presence request refused"
      });
    }
    return yield* Schema42.decodeUnknownEffect(Output14)(
      response.body
    ).pipe(Effect24.mapError(clientError));
  }
);

// packages/mailbox-client/src/tid.ts
var tid = (millis, clockId, micros = 0) => {
  let number = (BigInt(millis) * 1000n + BigInt(Math.abs(micros) % 1e3)) * 1024n + BigInt(clockId % 1024);
  const alphabet2 = "234567abcdefghijklmnopqrstuvwxyz";
  let text = "";
  for (let index = 0; index < 13; index += 1) {
    text = (alphabet2[Number(number % 32n)] ?? "2") + text;
    number /= 32n;
  }
  return text;
};
var randomTid = (millis) => {
  const words = crypto.getRandomValues(new Uint16Array(2));
  return tid(millis, words[0] ?? 0, words[1] ?? 0);
};

// packages/lexicon/src/transport-failure.ts
import { Schema as Schema43 } from "effect";
var TransportFailure = class extends Schema43.TaggedError()(
  "TransportFailure",
  { cause: Schema43.Defect(), reason: Schema43.String }
) {
};

// packages/mailbox-client/src/transport.ts
import { Clock as Clock3, Effect as Effect25, Layer as Layer4, Result as Result3, Schema as Schema44 } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
var transportLayer = (endpoint, audience, identity) => Layer4.effect(
  Transport,
  Effect25.gen(function* makeTransport() {
    const http = yield* HttpClient.HttpClient;
    return Transport.of({
      request: Effect25.fn("MailboxCli.request")(
        function* requestCall(request) {
          const now = Math.floor((yield* Clock3.currentTimeMillis) / 1e3);
          const nonce = yield* Effect25.sync(
            () => base64url2(crypto.getRandomValues(new Uint8Array(16)))
          );
          const token = yield* serviceToken(
            {
              aud: audience,
              exp: now + 60,
              iat: now,
              iss: identity.did,
              jti: nonce,
              lxm: request.nsid
            },
            yield* importSigning(identity)
          );
          const url = new URL(
            request.nsid.startsWith("/") ? request.nsid : `/xrpc/${request.nsid}`,
            endpoint
          );
          if (request.params !== void 0) {
            for (const [name, value] of Object.entries(request.params)) {
              if (Schema44.is(Schema44.String)(value) || Schema44.is(Schema44.Finite)(value) || Schema44.is(Schema44.Boolean)(value)) {
                url.searchParams.set(name, String(value));
              }
            }
          }
          let outgoing = HttpClientRequest.make(request.method)(
            url.href
          ).pipe(HttpClientRequest.bearerToken(token));
          if (request.input !== void 0) {
            outgoing = yield* HttpClientRequest.bodyJson(
              outgoing,
              request.input
            );
          }
          const response = yield* http.execute(outgoing);
          const body = yield* response.text;
          const json2 = yield* Schema44.decodeUnknownEffect(
            Schema44.fromJsonString(Schema44.toEncoded(Data))
          )(body).pipe(Effect25.result);
          if (Result3.isFailure(json2)) {
            return { body, kind: "text", status: response.status };
          }
          return {
            body: json2.success,
            kind: "json",
            status: response.status
          };
        },
        (effect, request) => effect.pipe(
          timeout(
            [
              "sh.mschf.ratking.runtime.acquireLease",
              "sh.mschf.ratking.runtime.renewLease",
              "sh.mschf.ratking.runtime.releaseLease"
            ].includes(request.nsid) ? LEASE_MS : REQUEST_MS
          )
        ),
        Effect25.mapError(
          () => new TransportFailure({
            cause: null,
            reason: "Service-auth HTTP call failed"
          })
        )
      )
    });
  })
);

// packages/lexicon/src/mailbox.subscribe.ts
import { Effect as Effect26, Schema as Schema45 } from "effect";
var Auth = Schema45.StructWithRest(
  Schema45.Struct({ token: lexString({ type: "string" }) }),
  [Schema45.Record(Schema45.String, Data)]
);
var Params16 = Schema45.StructWithRest(
  Schema45.Struct({
    generation: Schema45.Int.check(
      Schema45.isGreaterThanOrEqualTo(1),
      Schema45.isLessThanOrEqualTo(9007199254740991)
    ),
    leaseId: lexString({ format: "tid", type: "string" }).pipe(
      Schema45.brand("Lexicon:tid")
    ),
    recipientDid: lexString({ format: "did", type: "string" }).pipe(
      Schema45.brand("Lexicon:did")
    )
  }),
  [Schema45.Record(Schema45.String, Data)]
);
var Message = Schema45.Union([
  Schema45.StructWithRest(
    Schema45.Struct({
      $type: Schema45.Literal("sh.mschf.ratking.mailbox.subscribe#notice"),
      seq: Schema45.Int.check(
        Schema45.isGreaterThanOrEqualTo(0),
        Schema45.isLessThanOrEqualTo(9007199254740991)
      )
    }),
    [Schema45.Record(Schema45.String, Data)]
  ),
  TaggedMap.check(
    Schema45.makeFilter(
      (value) => !["sh.mschf.ratking.mailbox.subscribe#notice"].includes(value.$type),
      { expected: "unknown union tag only" }
    )
  )
]);
var ParamsFromQuery6 = Schema45.StructWithRest(
  Schema45.Struct({
    generation: Schema45.FiniteFromString,
    leaseId: Schema45.String,
    recipientDid: Schema45.String
  }),
  [Schema45.Record(Schema45.String, Data)]
).pipe(Schema45.decodeTo(Params16));
var encodeParams11 = Effect26.fn("lexicon.encodeParams")(
  function* encodeParams12(params) {
    return entries(
      yield* Schema45.decodeUnknownEffect(Params2)(
        yield* Schema45.encodeEffect(ParamsFromQuery6)(params)
      )
    );
  }
);
var decodeParams11 = Effect26.fn("lexicon.decodeParams")(
  function* decodeParams12(entries2) {
    return yield* Schema45.decodeUnknownEffect(ParamsFromQuery6)(
      parameters(entries2)
    );
  }
);
var Method15 = {
  nsid: "sh.mschf.ratking.mailbox.subscribe",
  params: Params16,
  path: "/xrpc/sh.mschf.ratking.mailbox.subscribe"
};
var Notice = Schema45.StructWithRest(
  Schema45.Struct({
    seq: Schema45.Int.check(
      Schema45.isGreaterThanOrEqualTo(0),
      Schema45.isLessThanOrEqualTo(9007199254740991)
    )
  }),
  [Schema45.Record(Schema45.String, Data)]
);

// packages/mailbox-client/src/watch.ts
import {
  Clock as Clock4,
  Context as Context10,
  Duration as Duration2,
  Effect as Effect27,
  Option as Option3,
  Predicate,
  Schedule as Schedule2,
  Schema as Schema46,
  Stream
} from "effect";
import { Socket } from "effect/socket";
var WebSocketPort = class extends Context10.Service()("@rat-king/mailbox-client/WebSocketPort") {
};
var socketError = (error) => {
  if (Predicate.isTagged(error.reason, "SocketCloseError")) {
    if (error.reason.code === 4409) {
      return new MailboxClientError({
        error: "LeaseMismatch",
        reason: "Mailbox subscription lease changed"
      });
    }
    if (error.reason.code === 4401) {
      return new MailboxClientError({
        error: "AuthRequired",
        reason: "Mailbox subscription authentication refused"
      });
    }
  }
  return new MailboxClientError({
    error: "SocketDisconnected",
    reason: "Mailbox subscription disconnected"
  });
};
var watch = (config, poll, afterSeq, fence) => Stream.suspend(() => {
  let checkpoint = afterSeq;
  let connections = 0;
  const connection = Stream.unwrap(
    Effect27.gen(function* connect() {
      if (connections > 0) {
        yield* config.onRetryMetric?.("consumeReconnect") ?? Effect27.void;
      }
      connections += 1;
      if (fence.did !== config.identity.did) {
        return yield* new MailboxClientError({
          reason: "Watch fence DID differs from recipient"
        });
      }
      const params = yield* Schema46.decodeUnknownEffect(
        Schema46.toType(Params16)
      )({
        generation: fence.generation,
        leaseId: fence.leaseId,
        recipientDid: config.identity.did
      }).pipe(Effect27.mapError(clientError));
      const url = new URL(Method15.path, config.endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      for (const [name, value] of yield* encodeParams11(params).pipe(
        Effect27.mapError(clientError)
      )) {
        url.searchParams.set(name, value);
      }
      const port = yield* Effect27.serviceOption(WebSocketPort);
      const socket = yield* Socket.fromWebSocket(
        Effect27.acquireRelease(
          Effect27.try({
            catch: (cause) => new Socket.SocketError({
              reason: new Socket.SocketOpenError({
                cause,
                kind: "Unknown"
              })
            }),
            try: () => Option3.isSome(port) ? port.value.connect(url.href) : new globalThis.WebSocket(url.href)
          }),
          (ws) => Effect27.sync(() => {
            ws.close(1e3);
          })
        ),
        { highWaterMark: 65536 }
      );
      const reader = yield* socket.reader.pipe(Effect27.mapError(socketError));
      const writer = yield* socket.writer;
      const now = Math.floor((yield* Clock4.currentTimeMillis) / 1e3);
      const token = yield* serviceToken(
        {
          aud: config.serviceDid.replace(/(?:#mailbox)?$/u, "#mailbox"),
          exp: now + 60,
          iat: now,
          iss: config.identity.did,
          jti: base64url2(crypto.getRandomValues(new Uint8Array(16))),
          lxm: Method15.nsid
        },
        yield* importSigning(config.identity).pipe(
          Effect27.mapError(clientError)
        )
      ).pipe(Effect27.mapError(clientError));
      const auth = yield* Schema46.encodeEffect(Auth)({
        $type: "sh.mschf.ratking.mailbox.subscribe#auth",
        token
      }).pipe(Effect27.mapError(clientError));
      yield* writer.write(JSON.stringify(auth)).pipe(Effect27.mapError(socketError));
      const receiveNotice = Effect27.gen(function* receiveNotice2() {
        const frames = yield* reader.pull.pipe(Effect27.mapError(socketError));
        for (const frame of frames) {
          yield* Schema46.decodeUnknownEffect(
            Schema46.fromJsonString(Notice)
          )(
            Schema46.is(Schema46.String)(frame) ? frame : new TextDecoder().decode(frame)
          ).pipe(Effect27.mapError(clientError));
        }
      });
      yield* receiveNotice;
      let catchUp = true;
      return Stream.fromEffectRepeat(
        Effect27.suspend(() => catchUp ? Effect27.void : receiveNotice).pipe(
          Effect27.flatMap(() => poll(checkpoint)),
          Effect27.tap(
            (batch) => Effect27.sync(() => {
              catchUp = batch.hasMore === true;
            })
          )
        )
      );
    })
  );
  return connection.pipe(
    Stream.filter((batch) => batch.events.length > 0),
    Stream.tap(
      (batch) => Effect27.sync(() => {
        checkpoint = batch.throughSeq;
      })
    ),
    Stream.retry(
      Schedule2.exponential("100 millis").pipe(
        Schedule2.jittered,
        Schedule2.modifyDelay(
          ({ duration }) => Effect27.succeed(Math.min(5e3, Duration2.toMillis(duration)))
        ),
        Schedule2.while(
          ({ input }) => input.error === "SocketDisconnected"
        )
      )
    )
  );
});

// packages/mailbox-client/src/mailbox.ts
var POLL_MAX_PAGES = 10;
var decodeBody = (body) => Effect28.try({
  catch: () => new MailboxClientError({ reason: "Invalid UTF-8 body" }),
  try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body)
});
var openPass = Effect28.fn("RatKingMailbox.openPass")(function* openPass2(envelope, receipt, recipientDid, resolver) {
  const via = yield* Schema47.decodeUnknownEffect(Via)(receipt.via);
  if (via.worker !== envelope.aad.senderDid || via.worker !== receipt.message.senderDid) {
    return yield* new MailboxClientError({
      reason: "Invalid pass sender binding"
    });
  }
  const workerPublicKey = yield* decodeDidKey(via.worker);
  const importPublicKey = crypto.subtle.importKey.bind(crypto.subtle);
  const workerKey = yield* cryptoOperation(
    importPublicKey.bind(
      crypto.subtle,
      "jwk",
      workerPublicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    )
  );
  const resolveSigningKey = (did, keyId2) => did === via.worker && keyId2 === `${via.worker}#${via.worker.slice("did:key:".length)}` ? Effect28.succeed(workerKey) : Effect28.fail(
    new EnvelopeFailure({ reason: "Unauthorized pass signing key" })
  );
  if (receipt.delegatedFor === void 0 && (envelope.aad.recipientDid !== recipientDid || envelope.aad.recipientKeyId !== `${recipientDid}#encryption` || receipt.recipientDid !== recipientDid || receipt.message.messageId !== envelope.aad.messageId)) {
    return yield* new MailboxClientError({
      reason: "Invalid pass recipient binding"
    });
  }
  const payload = yield* receipt.delegatedFor === void 0 ? openPlaintext(envelope, resolveSigningKey) : openDelegated(envelope, receipt, recipientDid, resolveSigningKey);
  const content = yield* Schema47.decodeUnknownEffect(PayloadJson)(
    yield* decodeBody(payload.body)
  );
  if (content.from !== via.desk) {
    return yield* new MailboxClientError({
      reason: "Invalid pass desk payload"
    });
  }
  const deskKey = yield* resolver.resolve(
    via.deskDid,
    `${via.deskDid}#atproto`,
    "authentication"
  );
  const key = yield* Schema47.decodeUnknownEffect(PublicKey2)(
    yield* cryptoOperation(
      crypto.subtle.exportKey.bind(crypto.subtle, "jwk", deskKey)
    )
  );
  const recordedAt = Date.parse(receipt.recordedAt ?? "") / 1e3;
  const pass = yield* verifyPass(
    {
      grantable: /* @__PURE__ */ new Set(["rk.send.plain"]),
      issuerScope: ["rk.send.plain"],
      knownDesk: { did: via.deskDid, key, name: via.desk }
    },
    via.pass,
    recordedAt
  ).pipe(
    Effect28.provide(signatures),
    Effect28.provideService(
      NonceBinding,
      yield* makeMemoryNonceBinding(Effect28.succeed(recordedAt))
    )
  );
  if (pass.record.worker !== via.worker || pass.record.run !== via.run || !pass.record.scope.includes("rk.send.plain")) {
    return yield* new MailboxClientError({
      reason: "Invalid pass run or scope binding"
    });
  }
  return payload;
});
var openReceived = Effect28.fn("RatKingMailbox.openReceived")(
  function* openReceived2(envelope, receipt, identity, resolver) {
    if (receipt?.via !== void 0) {
      return yield* openPass(envelope, receipt, identity.did, resolver);
    }
    const resolveSigningKey = (did, keyId2) => resolver.resolve(did, keyId2, "authentication").pipe(
      Effect28.mapError(
        () => new EnvelopeFailure({ reason: "Unauthorized sender signing key" })
      )
    );
    if (receipt?.delegatedFor !== void 0) {
      return yield* openDelegated(
        envelope,
        receipt,
        identity.did,
        resolveSigningKey
      );
    }
    return yield* open({
      envelope,
      recipientDid: identity.did,
      recipientKey: yield* importAgreement(identity),
      recipientKeyId: `${identity.did}#encryption`,
      resolveSigningKey
    });
  }
);
var sendIntent = (opts) => {
  const intent = {
    wakeReason: opts?.wakeReason ?? "to",
    woke: opts?.woke ?? true
  };
  if (opts?.critical !== void 0) {
    Object.assign(intent, { critical: opts.critical });
  }
  return intent;
};
var RatKingMailbox = class extends Context11.Service()("@rat-king/mailbox-client/RatKingMailbox") {
};
var layer = (config, resolverLayer = staticResolver(config.documents)) => Layer5.effect(
  RatKingMailbox,
  Effect28.gen(function* makeMailbox() {
    const client = yield* MailboxClient;
    const transport = yield* Transport;
    const resolver = yield* DidResolver;
    const { identity } = config;
    const list = Effect28.fn("RatKingMailbox.list")(
      (params) => Schema47.decodeUnknownEffect(Schema47.toType(Params9))({
        ...params,
        recipientDid: identity.did
      }).pipe(Effect28.flatMap(client.list), Effect28.mapError(clientError))
    );
    const poll = Effect28.fn("RatKingMailbox.poll")(
      function* poll2(afterSeq) {
        const first = yield* list({ afterSeq, limit: 100 });
        const events = [...first.events];
        let { cursor } = first;
        let pages = 1;
        const cursors = /* @__PURE__ */ new Set();
        while (cursor !== void 0 && pages < POLL_MAX_PAGES) {
          if (cursors.has(cursor)) {
            return yield* new MailboxClientError({
              reason: "Repeated mailbox page cursor"
            });
          }
          cursors.add(cursor);
          const page = yield* list({ afterSeq, cursor, limit: 100 });
          pages += 1;
          if (page.throughSeq !== first.throughSeq) {
            return yield* new MailboxClientError({
              reason: "Snapshot watermark changed during pagination"
            });
          }
          events.push(...page.events);
          ({ cursor } = page);
        }
        if (cursor !== void 0) {
          const last = events.at(-1)?.seq;
          if (!Schema47.is(Schema47.Int)(last) || !Number.isSafeInteger(last) || last <= afterSeq) {
            return yield* new MailboxClientError({
              reason: "Mailbox page did not advance its sequence"
            });
          }
          return { events, hasMore: true, throughSeq: last };
        }
        return { events, throughSeq: first.throughSeq };
      },
      (effect) => effect.pipe(
        timeout(OPERATION_MS),
        Effect28.mapError(clientError)
      )
    );
    return RatKingMailbox.of({
      ...attentionClient(client, identity),
      ack: Effect28.fn("RatKingMailbox.ack")(
        (input) => Schema47.decodeUnknownEffect(Schema47.toType(Input6))({
          ...input,
          recipientDid: identity.did
        }).pipe(Effect28.flatMap(client.ack), Effect28.mapError(clientError))
      ),
      deliver: Effect28.fn("RatKingMailbox.deliver")(
        (input) => Schema47.decodeUnknownEffect(Schema47.toType(Input7))({
          ...input,
          recipientDid: identity.did
        }).pipe(Effect28.flatMap(client.deliver), Effect28.mapError(clientError))
      ),
      lease: {
        acquire: Effect28.fn("RatKingMailbox.lease.acquire")(
          (input) => Schema47.decodeUnknownEffect(Schema47.toType(Input10))(
            input
          ).pipe(
            Effect28.flatMap(client.acquireLease),
            Effect28.map((output) => output.lease),
            Effect28.mapError(clientError)
          )
        ),
        release: Effect28.fn("RatKingMailbox.lease.release")(
          (input) => Schema47.decodeUnknownEffect(Schema47.toType(Input11))(
            input
          ).pipe(
            Effect28.flatMap(client.releaseLease),
            Effect28.mapError(clientError)
          )
        ),
        renew: Effect28.fn("RatKingMailbox.lease.renew")(
          (input) => Schema47.decodeUnknownEffect(Schema47.toType(Input12))(input).pipe(
            Effect28.flatMap(client.renewLease),
            Effect28.map((output) => output.lease),
            Effect28.mapError(clientError)
          )
        ),
        resolve: Effect28.fn("RatKingMailbox.lease.resolve")(
          (did) => Schema47.decodeUnknownEffect(Schema47.toType(Params14))({
            did
          }).pipe(
            Effect28.flatMap(client.resolveLease),
            Effect28.map((output) => output.lease),
            Effect28.mapError(clientError)
          )
        )
      },
      list,
      open: Effect28.fn("RatKingMailbox.open")(function* open3(input, receipt) {
        const envelope = yield* Schema47.decodeUnknownEffect(
          Schema47.toType(EncryptedEnvelope)
        )(input);
        const payload = yield* openReceived(
          envelope,
          receipt,
          identity,
          resolver
        );
        const body = yield* decodeBody(payload.body);
        const via = receipt?.via;
        const carbonCopy = yield* Schema47.decodeUnknownEffect(
          Schema47.fromJsonString(
            Schema47.Struct({
              $type: Schema47.Literal("sh.mschf.ratking.mailbox.cc"),
              body: Schema47.String,
              primary: Schema47.Struct({
                messageId: Schema47.String,
                recipientDid: Schema47.String,
                senderDid: Schema47.String
              })
            })
          )
        )(body).pipe(Effect28.option);
        const result = {
          body,
          encrypted: !plaintext(envelope),
          senderDid: payload.aad.senderDid,
          tid: payload.aad.messageId,
          verified: true
        };
        if (via !== void 0) {
          result.via = { desk: via.desk, deskDid: via.deskDid, run: via.run };
        }
        if (receipt?.delegatedTo !== void 0) {
          result.delegatedTo = receipt.delegatedTo;
        }
        if (receipt?.delegatedFor !== void 0 && receipt.originalId !== void 0) {
          result.delegatedFor = receipt.delegatedFor;
          result.originalId = receipt.originalId;
          result.tid = receipt.message.messageId;
        }
        if (Option4.isSome(carbonCopy)) {
          if (carbonCopy.value.primary.senderDid !== payload.aad.senderDid || carbonCopy.value.primary.messageId !== payload.replyTo?.messageId || payload.replyTo.senderDid !== payload.aad.senderDid) {
            return yield* new MailboxClientError({
              reason: "Invalid CC primary link"
            });
          }
          result.cc = carbonCopy.value.primary;
          result.body = carbonCopy.value.body;
        }
        if (payload.replyTo !== void 0) {
          result.replyTo = payload.replyTo;
        }
        if (payload.urgent !== void 0) {
          result.urgent = payload.urgent;
        }
        return result;
      }, Effect28.mapError(clientError)),
      poll,
      putDidDocument: Effect28.fn("RatKingMailbox.putDidDocument")(
        (document) => Schema47.decodeUnknownEffect(Schema47.toType(Input))({
          document
        }).pipe(
          Effect28.flatMap(client.putDidDocument),
          Effect28.mapError(clientError)
        )
      ),
      send: Effect28.fn("RatKingMailbox.send")(
        function* send(to, body, opts) {
          if (opts?.recordType !== void 0) {
            const presence = yield* lookupPresence(to).pipe(
              Effect28.provideService(Transport, transport),
              timeoutOption("2 seconds"),
              Effect28.orElseSucceed(() => Option4.none())
            );
            const reason = readerCannotRender(
              to,
              opts.recordType,
              Option4.getOrUndefined(presence)
            );
            if (reason !== void 0) {
              return yield* new MailboxClientError({ reason });
            }
          }
          if (opts?.fence !== void 0 && opts.fence.did !== identity.did) {
            return yield* new MailboxClientError({
              reason: "Send fence DID differs from sender"
            });
          }
          const now = yield* Clock5.currentTimeMillis;
          const messageId = yield* Effect28.sync(() => randomTid(now));
          const aad = {
            messageId,
            recipientDid: to,
            recipientKeyId: `${to}#encryption`,
            senderDid: identity.did
          };
          if (opts?.expiresAt !== void 0) {
            aad.expiresAt = opts.expiresAt;
          }
          const raw = {
            aad,
            body: new TextEncoder().encode(body),
            suite: opts?.encrypt === false ? plaintextSuite : suite,
            version: 1
          };
          if (opts?.replyTo !== void 0) {
            raw.replyTo = opts.replyTo;
          }
          if (opts?.urgent !== void 0) {
            raw.urgent = opts.urgent;
          }
          const payload = yield* Schema47.decodeUnknownEffect(
            Schema47.toType(SigningPayload)
          )(raw);
          const envelope = yield* seal({
            payload,
            recipientKey: yield* resolver.resolve(
              to,
              payload.aad.recipientKeyId,
              "keyAgreement"
            ),
            recipientKeyId: payload.aad.recipientKeyId,
            signingKey: yield* importSigning(identity),
            signingKeyId: `${identity.did}#atproto`
          });
          const input = {
            envelope,
            ...sendIntent(opts)
          };
          if (opts?.fence !== void 0) {
            input.generation = opts.fence.generation;
            input.leaseId = opts.fence.leaseId;
          }
          return yield* client.send(
            yield* Schema47.decodeUnknownEffect(Schema47.toType(Input9))(
              input
            )
          );
        },
        (effect) => effect.pipe(
          timeout(OPERATION_MS),
          Effect28.mapError(clientError)
        )
      ),
      watch: (afterSeq, fence) => watch(config, poll, afterSeq, fence)
    });
  })
).pipe(
  Layer5.provide([
    resolverLayer,
    clientLayer.pipe(
      Layer5.provideMerge(
        transportLayer(
          config.endpoint,
          config.serviceDid.replace(/(?:#mailbox)?$/u, "#mailbox"),
          config.identity
        )
      )
    )
  ])
);

// packages/lexicon/src/mailbox.getPeerDocument.ts
import { Effect as Effect29, Schema as Schema48 } from "effect";
var Params17 = Schema48.StructWithRest(
  Schema48.Struct({
    did: lexString({ format: "did", type: "string" }).pipe(
      Schema48.brand("Lexicon:did")
    )
  }),
  [Schema48.Record(Schema48.String, Data)]
);
var Input15 = Schema48.Undefined;
var Output15 = Schema48.StructWithRest(
  Schema48.Struct({ document: DidDocument }),
  [Schema48.Record(Schema48.String, Data)]
);
var ParamsFromQuery7 = Schema48.StructWithRest(
  Schema48.Struct({ did: Schema48.String }),
  [Schema48.Record(Schema48.String, Data)]
).pipe(Schema48.decodeTo(Params17));
var encodeParams13 = Effect29.fn("lexicon.encodeParams")(
  function* encodeParams14(params) {
    return entries(
      yield* Schema48.decodeUnknownEffect(Params2)(
        yield* Schema48.encodeEffect(ParamsFromQuery7)(params)
      )
    );
  }
);
var decodeParams13 = Effect29.fn("lexicon.decodeParams")(
  function* decodeParams14(entries2) {
    return yield* Schema48.decodeUnknownEffect(ParamsFromQuery7)(
      parameters(entries2)
    );
  }
);
var ErrorBody15 = XrpcErrorBody;
var Method16 = {
  defaults: {},
  error: ErrorBody15,
  input: Input15,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.mailbox.getPeerDocument",
  output: Output15,
  outputEncoding: "application/json",
  params: Params17,
  path: "/xrpc/sh.mschf.ratking.mailbox.getPeerDocument"
};

// packages/mailbox-client/src/prepare.ts
import {
  Clock as Clock7,
  Context as Context12,
  Data as Data2,
  Effect as Effect35,
  Layer as Layer6,
  Match as Match4,
  Predicate as Predicate2,
  Result as Result4,
  Schema as Schema58
} from "effect";

// packages/lexicon/src/attention.receipt.ts
import { Schema as Schema49 } from "effect";
var Main9 = Schema49.StructWithRest(
  Schema49.Struct({
    $type: Schema49.Literal("sh.mschf.ratking.attention.receipt"),
    operation: lexString({
      enum: ["putPreferences", "putStatus"],
      type: "string"
    }).pipe(Schema49.decodeTo(Schema49.Literals(["putPreferences", "putStatus"]))),
    seq: Schema49.Int.check(
      Schema49.isGreaterThanOrEqualTo(1),
      Schema49.isLessThanOrEqualTo(9007199254740991)
    )
  }),
  [Schema49.Record(Schema49.String, Data)]
);

// packages/mailbox-client/src/consume.ts
import {
  Clock as Clock6,
  DateTime as DateTime2,
  Duration as Duration3,
  Effect as Effect30,
  Match as Match3,
  Option as Option5,
  Random,
  Schedule as Schedule3,
  Schema as Schema51,
  Stream as Stream2
} from "effect";
import { createMachine, initialTransition, transition } from "xstate";

// packages/mailbox-client/src/handoff-history.ts
var HANDOFF_HISTORY_CAPACITY = 2048;
var handoffHistory = () => {
  const keys = /* @__PURE__ */ new Set();
  const remember = (key) => {
    keys.delete(key);
    keys.add(key);
    if (keys.size > HANDOFF_HISTORY_CAPACITY) {
      const oldest = keys.values().next();
      if (oldest.done !== true) {
        keys.delete(oldest.value);
      }
    }
  };
  return {
    add: remember,
    delete: (key) => keys.delete(key),
    has: (key) => {
      if (!keys.has(key)) {
        return false;
      }
      remember(key);
      return true;
    },
    size: () => keys.size
  };
};

// packages/mailbox-client/src/retry-metrics.ts
import { Match as Match2, Schema as Schema50 } from "effect";
var RetryEvent = Schema50.Literals([
  "acquireOk",
  "acquireLeaseHeld",
  "acquireMailboxUnavailable",
  "acquireTimeout",
  "acquireOther",
  "renewLeaseHeld",
  "renewMailboxUnavailable",
  "renewTimeout",
  "renewLeaseExpired",
  "renewLeaseMismatch",
  "renewOther",
  "consumeReconnect",
  "sendRetry"
]);
var retryFailure = (operation, error) => {
  if (error.reason === "Acquire attempt timed out" || error.reason === "Renewal attempt timed out") {
    return operation === "acquire" ? "acquireTimeout" : "renewTimeout";
  }
  if (operation === "acquire") {
    return Match2.value(error.error ?? "").pipe(
      Match2.when("LeaseHeld", () => "acquireLeaseHeld"),
      Match2.when(
        "MailboxUnavailable",
        () => "acquireMailboxUnavailable"
      ),
      Match2.orElse(() => "acquireOther")
    );
  }
  return Match2.value(error.error ?? "").pipe(
    Match2.when("LeaseHeld", () => "renewLeaseHeld"),
    Match2.when("MailboxUnavailable", () => "renewMailboxUnavailable"),
    Match2.when("LeaseExpired", () => "renewLeaseExpired"),
    Match2.when("LeaseMismatch", () => "renewLeaseMismatch"),
    Match2.orElse(() => "renewOther")
  );
};

// packages/mailbox-client/src/consume.ts
var consumerMachine = createMachine({
  context: {},
  id: "mailbox-consumer",
  initial: "acquiring",
  states: {
    acquiring: {
      on: {
        ACQUIRED: { target: "consuming" },
        HELD: { target: "waiting" },
        REFUSED: { target: "closed" }
      }
    },
    closed: { type: "final" },
    consuming: {
      on: { LOST: { target: "releasing" }, STOP: { target: "releasing" } }
    },
    releasing: { on: { RELEASED: { target: "closed" } } },
    waiting: { on: { RETRY: { target: "acquiring" } } }
  }
});
var ATTEMPT_MS = LEASE_MS;
var RENEW_FLOOR_MS = 250;
var attemptTimedOut = (reason) => new MailboxClientError({ error: "MailboxUnavailable", reason });
var TIMED_OUT = "Renewal attempt timed out";
var unavailable = (error) => error.status === void 0 ? error.error === void 0 || error.error === "MailboxUnavailable" : error.status >= 500 || error.status === 429;
var expiredRefusal = (error) => error.error === "InvalidTransition" && error.reason === "Expired message";
var settledRefusal = (error) => error.error === "InvalidTransition";
var releasedRefusal = (error) => error.error === "LeaseMismatch";
var consume = (mailbox, did, handler, options) => Effect30.scoped(
  Effect30.gen(function* runConsumer() {
    let [state] = initialTransition(consumerMachine);
    const step = (event) => Effect30.sync(() => {
      [state] = transition(consumerMachine, state, { type: event });
    });
    const acquire = Effect30.gen(function* acquire2() {
      const now = yield* Clock6.currentTimeMillis;
      const input = {
        did,
        expiresAt: DateTime2.formatIso(DateTime2.makeUnsafe(now + 3e5)),
        harness: options.harness
      };
      if (options.renders !== void 0) {
        Object.assign(input, { renders: options.renders });
      }
      if (options.resume !== void 0) {
        if (options.resume.did !== did) {
          return yield* new MailboxClientError({
            reason: "Resume fence identity mismatch"
          });
        }
        Object.assign(input, {
          generation: options.resume.generation,
          leaseId: options.resume.leaseId
        });
      }
      yield* Effect30.logInfo(
        `lease acquire-attempt name=${options.leaseName ?? did} generation=${input.generation ?? "new"} expiresAt=${input.expiresAt} reason=acquire requested`
      );
      return yield* mailbox.lease.acquire(input).pipe(
        timeoutOrElse({
          duration: ATTEMPT_MS,
          orElse: () => Effect30.fail(attemptTimedOut("Acquire attempt timed out"))
        }),
        Effect30.tap(() => options.onRetryMetric?.("acquireOk") ?? Effect30.void),
        Effect30.tapError(
          (error) => options.onRetryMetric?.(retryFailure("acquire", error)) ?? Effect30.void
        ),
        Effect30.tapError(
          (error) => Effect30.logInfo(
            `lease acquire-failed name=${options.leaseName ?? did} generation=${input.generation ?? "new"} expiresAt=${input.expiresAt} reason=${JSON.stringify(error.error ?? error.reason)}`
          )
        ),
        Effect30.catchIf(
          (error) => error.error === "LeaseHeld",
          (error) => Effect30.gen(function* waitHolder() {
            if (options.failOnHeld === true) {
              yield* step("REFUSED");
              return yield* Effect30.fail(error);
            }
            yield* step("HELD");
            const holder = yield* mailbox.lease.resolve(did).pipe(
              timeout(ATTEMPT_MS),
              Effect30.mapError(clientError),
              Effect30.catchIf(
                (failure3) => failure3.error === "LeaseNotFound",
                () => Effect30.void
              )
            );
            const current2 = yield* Clock6.currentTimeMillis;
            if (holder !== void 0) {
              yield* Effect30.interruptible(
                Effect30.sleep(
                  Math.max(1, Date.parse(holder.expiresAt) - current2)
                )
              );
            }
            yield* step("RETRY");
            return yield* Effect30.fail(error);
          })
        )
      );
    }).pipe(
      Effect30.retry(
        Schedule3.spaced("1 millis").pipe(
          Schedule3.modifyDelay(() => Random.nextBetween(0, 2e3)),
          Schedule3.while(
            ({ input }) => canAttempt(ATTEMPT_MS).pipe(
              Effect30.map(
                (fits) => fits && input.error === "LeaseHeld" && options.failOnHeld !== true
              )
            )
          ),
          retryBudget(ATTEMPT_MS)
        )
      )
    );
    const logLease = (event, lease, reason) => Effect30.logInfo(
      `lease ${event} name=${options.leaseName ?? did} generation=${lease.generation} expiresAt=${lease.expiresAt} reason=${JSON.stringify(reason)}`
    );
    let current = yield* Effect30.acquireRelease(
      acquire.pipe(
        Effect30.tap((lease) => logLease("acquire", lease, "acquired"))
      ),
      () => Effect30.gen(function* release() {
        yield* step("STOP");
        yield* mailbox.lease.release({
          did,
          generation: current.generation,
          leaseId: current.leaseId
        }).pipe(
          timeoutOrElse({
            duration: ATTEMPT_MS,
            orElse: () => Effect30.fail(attemptTimedOut("Release attempt timed out"))
          }),
          Effect30.tap(() => logLease("release", current, "scope closed")),
          Effect30.catchIf(
            releasedRefusal,
            () => logLease("loss", current, "release fence mismatch")
          ),
          Effect30.tapError(
            (error) => logLease("release-failed", current, error.reason).pipe(
              Effect30.andThen(
                Effect30.logWarning(
                  "Mailbox lease release not confirmed",
                  error
                )
              )
            )
          ),
          Effect30.ignore
        );
        yield* step("RELEASED");
      })
    );
    yield* step("ACQUIRED");
    if (options.onLease !== void 0) {
      yield* options.onLease(current);
    }
    const fence = () => ({
      did,
      generation: current.generation,
      leaseId: current.leaseId
    });
    const lost = (error) => Effect30.gen(function* classifyLoss() {
      yield* step("LOST");
      const actual = yield* mailbox.lease.resolve(did).pipe(
        timeout("2 seconds"),
        Effect30.option,
        Effect30.map(Option5.getOrUndefined)
      );
      const now = yield* Clock6.currentTimeMillis;
      let reason = "LeaseRenewalFailed";
      if (error.error === "LeaseExpired" || Date.parse(current.expiresAt) <= now) {
        reason = "LeaseExpired";
      }
      if (actual !== void 0 && (actual.leaseId !== current.leaseId || actual.generation !== current.generation)) {
        reason = "LeaseTakenOver";
      }
      yield* logLease(
        reason === "LeaseExpired" || reason === "LeaseRenewalFailed" && unavailable(error) ? "lapse" : "loss",
        current,
        `${reason}: ${error.reason}`
      );
      return yield* Effect30.fail(
        new MailboxClientError({ error: reason, reason: error.reason })
      );
    });
    const renew = Effect30.gen(function* renew2() {
      const now = yield* Clock6.currentTimeMillis;
      const remaining3 = Date.parse(current.expiresAt) - now;
      if (remaining3 <= 0) {
        return yield* new MailboxClientError({
          error: "LeaseExpired",
          reason: "Lease expired before renewal"
        });
      }
      yield* Effect30.sleep(Math.max(1, Math.floor(remaining3 / 2)));
      const renewedAt = yield* Clock6.currentTimeMillis;
      const renewal = {
        ...fence(),
        expiresAt: DateTime2.formatIso(
          DateTime2.makeUnsafe(renewedAt + 3e5)
        )
      };
      if (options.renders !== void 0) {
        Object.assign(renewal, { renders: options.renders });
      }
      current = yield* Effect30.suspend(
        () => Clock6.currentTimeMillis.pipe(
          Effect30.flatMap((time) => {
            const left = Date.parse(current.expiresAt) - time;
            if (left <= 0) {
              return Effect30.fail(
                new MailboxClientError({
                  error: "LeaseExpired",
                  reason: "Lease expired during renewal retries"
                })
              );
            }
            return logLease("renew-attempt", current, "renew requested").pipe(
              Effect30.andThen(mailbox.lease.renew(renewal)),
              timeoutOrElse({
                duration: Math.min(left, ATTEMPT_MS),
                orElse: () => Effect30.fail(
                  left > ATTEMPT_MS ? attemptTimedOut(TIMED_OUT) : new MailboxClientError({
                    error: "LeaseExpired",
                    reason: "Renewal exceeded lease expiry"
                  })
                )
              })
            );
          })
        )
      ).pipe(
        Effect30.tapError(
          (error) => options.onRetryMetric?.(retryFailure("renew", error)) ?? Effect30.void
        ),
        Effect30.tapError(
          (error) => logLease("renew-failed", current, error.reason)
        ),
        Effect30.retry(
          Schedule3.spaced("1 second").pipe(
            Schedule3.setInputType(),
            Schedule3.modifyDelay(
              ({ input }) => input.reason === TIMED_OUT ? Effect30.succeed(0) : Clock6.currentTimeMillis.pipe(
                Effect30.flatMap(
                  (time) => Random.nextBetween(
                    0,
                    Math.max(
                      0,
                      Math.min(
                        1e3,
                        Date.parse(current.expiresAt) - time - RENEW_FLOOR_MS
                      )
                    )
                  ).pipe(Effect30.map((delay) => Math.max(1, delay)))
                )
              )
            ),
            Schedule3.while(
              ({
                input,
                duration
              }) => Clock6.currentTimeMillis.pipe(
                Effect30.flatMap(
                  (time) => canAttempt(
                    RENEW_FLOOR_MS,
                    Duration3.toMillis(duration)
                  ).pipe(
                    Effect30.map(
                      (fits) => fits && unavailable(input) && Date.parse(current.expiresAt) - time >= RENEW_FLOOR_MS + Duration3.toMillis(duration)
                    )
                  )
                )
              )
            )
          )
        )
      );
      yield* logLease("renew", current, "renewed");
      if (options.onLease !== void 0) {
        yield* options.onLease(current);
      }
      return yield* Effect30.void;
    }).pipe(Effect30.repeat(Schedule3.spaced("0 millis")), Effect30.catch(lost));
    const handed = handoffHistory();
    const intake = mailbox.watch(options.afterSeq ?? 0, fence()).pipe(
      Stream2.runForEach(
        (batch) => Effect30.forEach(
          batch.events,
          (event) => Effect30.gen(function* accept() {
            if (Schema51.is(Main9)(event) && options.onAttentionReceipt !== void 0) {
              yield* options.onAttentionReceipt(event);
            }
            if (!Schema51.is(MessageEvent)(event)) {
              return;
            }
            const key = JSON.stringify([
              event.receipt.message.senderDid,
              event.receipt.message.messageId
            ]);
            if (options.ackOnReturn === false && handed.has(key)) {
              return;
            }
            const { onSkip, unopenable } = options;
            const skip = (reason) => onSkip === void 0 ? Effect30.void : onSkip({
              messageId: event.receipt.message.messageId,
              reason,
              senderDid: event.receipt.message.senderDid,
              seq: event.seq
            });
            const opened = yield* mailbox.open(event.envelope, event.receipt).pipe(
              Effect30.map(Option5.some),
              Effect30.catch(
                (error) => unopenable === void 0 ? Effect30.fail(error) : unopenable(event, error)
              )
            );
            if (Option5.isNone(opened)) {
              yield* skip("unopenable");
              return;
            }
            const message = opened.value;
            const input = { ...fence(), message: event.receipt.message };
            const delivered = yield* mailbox.deliver(input).pipe(
              Effect30.map(
                ({ receipt }) => Match3.value(receipt.state).pipe(
                  Match3.when(
                    "expired",
                    () => Option5.some("expired")
                  ),
                  Match3.when(
                    "acked",
                    () => Option5.some("settled")
                  ),
                  Match3.orElse(() => Option5.none())
                )
              ),
              Effect30.catchIf(
                expiredRefusal,
                () => Effect30.succeed(Option5.some("expired"))
              ),
              Effect30.catchIf(
                settledRefusal,
                () => Effect30.succeed(Option5.some("settled"))
              )
            );
            if (Option5.isSome(delivered)) {
              yield* skip(delivered.value);
              return;
            }
            const ack = event.receipt.delegatedTo === void 0 ? mailbox.ack(input).pipe(
              Effect30.catchIf(settledRefusal, () => Effect30.void),
              Effect30.asVoid
            ) : Effect30.void;
            handed.add(key);
            yield* handler(message, {
              ack,
              redelivered: event.receipt.state === "delivered",
              seq: event.seq
            }).pipe(
              Effect30.onError(() => Effect30.sync(() => handed.delete(key)))
            );
            if (options.ackOnReturn !== false) {
              yield* ack;
            }
          }),
          { discard: true }
        )
      ),
      Effect30.catch((error) => {
        if (Schema51.is(MailboxClientError)(error) && error.error === "LeaseMismatch") {
          return lost(error);
        }
        return Effect30.fail(error);
      })
    );
    yield* Effect30.raceFirst(intake, renew);
  })
);

// packages/lexicon/src/mailbox.nameHealth.ts
import { Effect as Effect31, Schema as Schema52 } from "effect";
var Lease = Schema52.StructWithRest(
  Schema52.Struct({
    expiresAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema52.brand("Lexicon:datetime")
    ),
    generation: Schema52.Int.check(
      Schema52.isGreaterThanOrEqualTo(1),
      Schema52.isLessThanOrEqualTo(9007199254740991)
    ),
    holder: lexString({ type: "string" }),
    pane: Schema52.optionalKey(lexString({ type: "string" }))
  }),
  [Schema52.Record(Schema52.String, Data)]
);
var Wake = Schema52.StructWithRest(
  Schema52.Struct({
    id: lexString({ format: "tid", type: "string" }).pipe(
      Schema52.brand("Lexicon:tid")
    ),
    recordedAt: lexString({ format: "datetime", type: "string" }).pipe(
      Schema52.brand("Lexicon:datetime")
    ),
    sender: lexString({ format: "did", type: "string" }).pipe(
      Schema52.brand("Lexicon:did")
    ),
    woke: Schema52.Boolean
  }),
  [Schema52.Record(Schema52.String, Data)]
);
var Params18 = Schema52.StructWithRest(
  Schema52.Struct({
    name: lexString({ maxLength: 128, type: "string" }),
    recipientDid: lexString({ format: "did", type: "string" }).pipe(
      Schema52.brand("Lexicon:did")
    )
  }),
  [Schema52.Record(Schema52.String, Data)]
);
var Input16 = Schema52.Undefined;
var Output16 = Schema52.StructWithRest(
  Schema52.Struct({
    complete: Schema52.Boolean,
    lastAck: Schema52.optionalKey(
      lexString({ format: "datetime", type: "string" }).pipe(
        Schema52.brand("Lexicon:datetime")
      )
    ),
    lease: Schema52.optionalKey(Lease),
    oldestWake: Schema52.optionalKey(Wake),
    oldestWakeSinceAck: Schema52.optionalKey(Wake),
    quietUnacked: Schema52.Int.check(
      Schema52.isGreaterThanOrEqualTo(0),
      Schema52.isLessThanOrEqualTo(9007199254740991)
    ),
    wakesSinceAck: Schema52.optionalKey(
      Schema52.Int.check(
        Schema52.isGreaterThanOrEqualTo(0),
        Schema52.isLessThanOrEqualTo(9007199254740991)
      )
    )
  }),
  [Schema52.Record(Schema52.String, Data)]
);
var ParamsFromQuery8 = Schema52.StructWithRest(
  Schema52.Struct({ name: Schema52.String, recipientDid: Schema52.String }),
  [Schema52.Record(Schema52.String, Data)]
).pipe(Schema52.decodeTo(Params18));
var encodeParams15 = Effect31.fn("lexicon.encodeParams")(
  function* encodeParams16(params) {
    return entries(
      yield* Schema52.decodeUnknownEffect(Params2)(
        yield* Schema52.encodeEffect(ParamsFromQuery8)(params)
      )
    );
  }
);
var decodeParams15 = Effect31.fn("lexicon.decodeParams")(
  function* decodeParams16(entries2) {
    return yield* Schema52.decodeUnknownEffect(ParamsFromQuery8)(
      parameters(entries2)
    );
  }
);
var ErrorBody16 = XrpcErrorBody;
var Method17 = {
  defaults: {},
  error: ErrorBody16,
  input: Input16,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.mailbox.nameHealth",
  output: Output16,
  outputEncoding: "application/json",
  params: Params18,
  path: "/xrpc/sh.mschf.ratking.mailbox.nameHealth"
};

// packages/mailbox-client/src/health.ts
import { Effect as Effect32, Schema as Schema53 } from "effect";
var Wake2 = Schema53.Struct({
  at: Schema53.Finite,
  id: Schema53.String,
  sender: Schema53.String
});
var MailboxHealth = Schema53.Struct({
  complete: Schema53.Boolean,
  lastAck: Schema53.NullOr(Schema53.Finite),
  lease: Schema53.NullOr(
    Schema53.Struct({
      expiresAt: Schema53.Finite,
      generation: Schema53.Int,
      holder: Schema53.String,
      pane: Schema53.NullOr(Schema53.String)
    })
  ),
  oldestWake: Schema53.NullOr(Wake2),
  oldestWakeSinceAck: Schema53.optionalKey(Schema53.NullOr(Wake2)),
  quietUnacked: Schema53.Int.check(Schema53.isGreaterThanOrEqualTo(0))
});
var readMailboxHealth = Effect32.fn("Mailbox.readHealth")(
  function* readMailboxHealth2(transport, did, name) {
    const params = yield* Schema53.decodeUnknownEffect(
      Schema53.toType(Params18)
    )({ name, recipientDid: did });
    const response = yield* transport.request({
      input: void 0,
      method: "GET",
      nsid: Method17.nsid,
      params: yield* Schema53.encodeEffect(Params18)(params)
    });
    if (response.status !== 200 || response.kind !== "json") {
      return yield* new MailboxClientError({
        reason: "Health projection unavailable (operator credentials required)"
      });
    }
    const value = yield* Schema53.decodeUnknownEffect(Output16)(
      response.body
    );
    const facts = {
      complete: value.complete,
      lastAck: value.lastAck === void 0 ? null : Date.parse(value.lastAck),
      lease: value.lease === void 0 ? null : {
        expiresAt: Date.parse(value.lease.expiresAt),
        generation: value.lease.generation,
        holder: value.lease.holder,
        pane: value.lease.pane ?? null
      },
      oldestWake: value.oldestWake === void 0 ? null : {
        at: Date.parse(value.oldestWake.recordedAt),
        id: value.oldestWake.id,
        sender: value.oldestWake.sender
      },
      quietUnacked: value.quietUnacked
    };
    if (value.wakesSinceAck === void 0) {
      return yield* Schema53.decodeEffect(MailboxHealth)(facts);
    }
    const since = value.oldestWakeSinceAck;
    return yield* Schema53.decodeEffect(MailboxHealth)({
      ...facts,
      oldestWakeSinceAck: since === void 0 ? null : {
        at: Date.parse(since.recordedAt),
        id: since.id,
        sender: since.sender
      }
    });
  },
  (effect) => effect.pipe(timeout("10 seconds"), Effect32.mapError(clientError))
);

// packages/lexicon/src/mailbox.listTraffic.ts
import { Effect as Effect33, Schema as Schema54 } from "effect";
var CriticalCount = Schema54.StructWithRest(
  Schema54.Struct({
    count: Schema54.Int.check(
      Schema54.isGreaterThanOrEqualTo(1),
      Schema54.isLessThanOrEqualTo(9007199254740991)
    ),
    day: lexString({ type: "string" }),
    senderDid: lexString({ format: "did", type: "string" }).pipe(
      Schema54.brand("Lexicon:did")
    )
  }),
  [Schema54.Record(Schema54.String, Data)]
);
var Via2 = Schema54.StructWithRest(
  Schema54.Struct({
    desk: lexString({ maxLength: 256, minLength: 1, type: "string" }),
    deskDid: lexString({ format: "did", type: "string" }).pipe(
      Schema54.brand("Lexicon:did")
    ),
    run: PassRun
  }),
  [Schema54.Record(Schema54.String, Data)]
);
var Entry = Schema54.StructWithRest(
  Schema54.Struct({
    body: Schema54.optionalKey(
      lexString({
        description: "UTF-8 body of a signed plaintext message, verified at admission. Absent for encrypted messages.",
        type: "string"
      })
    ),
    ciphertextSize: Schema54.Int.check(
      Schema54.isGreaterThanOrEqualTo(0),
      Schema54.isLessThanOrEqualTo(9007199254740991)
    ),
    messageId: lexString({ format: "tid", type: "string" }).pipe(
      Schema54.brand("Lexicon:tid")
    ),
    recipientDid: lexString({ format: "did", type: "string" }).pipe(
      Schema54.brand("Lexicon:did")
    ),
    recipientSeq: Schema54.Int.check(
      Schema54.isGreaterThanOrEqualTo(1),
      Schema54.isLessThanOrEqualTo(9007199254740991)
    ),
    senderDid: lexString({ format: "did", type: "string" }).pipe(
      Schema54.brand("Lexicon:did")
    ),
    seq: Schema54.Int.check(
      Schema54.isGreaterThanOrEqualTo(1),
      Schema54.isLessThanOrEqualTo(9007199254740991)
    ),
    state: lexString({
      knownValues: [
        "accepted",
        "queued",
        "delivered",
        "acked",
        "expired",
        "failed"
      ],
      type: "string"
    }),
    time: lexString({ format: "datetime", type: "string" }).pipe(
      Schema54.brand("Lexicon:datetime")
    ),
    via: Schema54.optionalKey(Via2)
  }),
  [Schema54.Record(Schema54.String, Data)]
);
var Params19 = Schema54.StructWithRest(
  Schema54.Struct({
    cursor: Schema54.optionalKey(lexString({ type: "string" })),
    limit: Schema54.optionalKey(
      Schema54.Int.check(
        Schema54.isGreaterThanOrEqualTo(1),
        Schema54.isLessThanOrEqualTo(100)
      )
    )
  }),
  [Schema54.Record(Schema54.String, Data)]
);
var Input17 = Schema54.Undefined;
var Output17 = Schema54.StructWithRest(
  Schema54.Struct({
    criticalCounts: Schema54.optionalKey(
      Schema54.Array(CriticalCount).check(
        Schema54.isMinLength(0),
        Schema54.isMaxLength(100)
      )
    ),
    cursor: lexString({ type: "string" }),
    events: Schema54.Array(Entry).check(
      Schema54.isMinLength(0),
      Schema54.isMaxLength(100)
    )
  }),
  [Schema54.Record(Schema54.String, Data)]
);
var ParamsFromQuery9 = Schema54.StructWithRest(
  Schema54.Struct({
    cursor: Schema54.optionalKey(Schema54.String),
    limit: Schema54.optionalKey(Schema54.FiniteFromString)
  }),
  [Schema54.Record(Schema54.String, Data)]
).pipe(Schema54.decodeTo(Params19));
var encodeParams17 = Effect33.fn("lexicon.encodeParams")(
  function* encodeParams18(params) {
    return entries(
      yield* Schema54.decodeUnknownEffect(Params2)(
        yield* Schema54.encodeEffect(ParamsFromQuery9)(params)
      )
    );
  }
);
var decodeParams17 = Effect33.fn("lexicon.decodeParams")(
  function* decodeParams18(entries2) {
    return yield* Schema54.decodeUnknownEffect(ParamsFromQuery9)(
      parameters(entries2)
    );
  }
);
var ErrorBody17 = XrpcErrorBody;
var Method18 = {
  defaults: { limit: 50 },
  error: ErrorBody17,
  input: Input17,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.mailbox.listTraffic",
  output: Output17,
  outputEncoding: "application/json",
  params: Params19,
  path: "/xrpc/sh.mschf.ratking.mailbox.listTraffic"
};

// packages/lexicon/turns.ts
import { Array as Arr, Schema as Schema56 } from "effect";

// packages/lexicon/src/agentgraph.turn.ts
import { Schema as Schema55 } from "effect";
var Main10 = Schema55.StructWithRest(
  Schema55.Struct({
    $type: Schema55.Literal("sh.mschf.agentgraph.turn"),
    agent: lexString({ type: "string" }).check(
      Schema55.isPattern(
        /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9_-]{0,31}$/u
      )
    ),
    at: lexString({ format: "datetime", type: "string" }).pipe(
      Schema55.brand("Lexicon:datetime")
    ),
    generation: Schema55.optionalKey(
      Schema55.Int.check(
        Schema55.isGreaterThanOrEqualTo(0),
        Schema55.isLessThanOrEqualTo(9007199254740991)
      )
    ),
    reason: Schema55.optionalKey(
      lexString({ type: "string" }).check(Schema55.isMaxLength(280))
    ),
    session: lexString({ type: "string" }).check(
      Schema55.isMinLength(1),
      Schema55.isMaxLength(128)
    ),
    state: lexString({
      enum: ["working", "done", "blocked", "idle", "crashed"],
      type: "string"
    }).pipe(
      Schema55.decodeTo(
        Schema55.Literals(["working", "done", "blocked", "idle", "crashed"])
      )
    ),
    stopReason: Schema55.optionalKey(
      lexString({
        enum: ["stop", "aborted", "error", "length"],
        type: "string"
      }).pipe(
        Schema55.decodeTo(Schema55.Literals(["stop", "aborted", "error", "length"]))
      )
    ),
    turnId: lexString({ type: "string" }).check(
      Schema55.isPattern(/^.+:[0-9]+$/u),
      Schema55.isMaxLength(128)
    ),
    version: lexString({ enum: ["0.1"], type: "string" }).pipe(
      Schema55.decodeTo(Schema55.Literals(["0.1"]))
    )
  }),
  [Schema55.Record(Schema55.String, Data)]
).check(
  Schema55.makeFilter(
    (value) => Object.keys(value).every(
      (key) => [
        "$type",
        "agent",
        "at",
        "generation",
        "reason",
        "session",
        "state",
        "stopReason",
        "turnId",
        "version"
      ].includes(key)
    ),
    {
      expected: "only allowed keys: $type, agent, at, generation, reason, session, state, stopReason, turnId, version"
    }
  )
).check(
  Schema55.makeFilter(
    (value) => !("generation" in value) || value.state === "crashed",
    { expected: "generation: allowed only when state is crashed" }
  )
);

// packages/lexicon/turns.ts
var Turn = Main10.check(
  Schema56.makeFilter(
    (value) => value.turnId.startsWith(`${value.session}:`) && Number.isSafeInteger(
      Number(value.turnId.slice(value.session.length + 1))
    ) && (value.stopReason === void 0 || value.state === "done") && (value.reason === void 0 || value.state === "blocked" || value.state === "crashed"),
    {
      expected: "session:n turnId; stopReason only on done; reason only on blocked or crashed"
    }
  )
);

// packages/mailbox-client/src/turn-health.ts
import { Effect as Effect34, Option as Option6, Schema as Schema57 } from "effect";
var readTurnHealth = Effect34.fn("Mailbox.readTurnHealth")(
  function* readTurnHealth2(transport, did, name, session) {
    let cursor = "0";
    let last = null;
    for (let page = 0; page < 100; page += 1) {
      const response = yield* transport.request({
        input: void 0,
        method: "GET",
        nsid: Method18.nsid,
        params: { cursor, limit: 100 }
      });
      if (response.status !== 200 || response.kind !== "json") {
        return yield* new MailboxClientError({
          reason: "Turn record observations unavailable"
        });
      }
      const output = yield* Schema57.decodeUnknownEffect(Output17)(
        response.body
      );
      for (const event of output.events) {
        if (event.senderDid !== did) {
          continue;
        }
        const text = event.body ?? "";
        const payload = Schema57.decodeOption(PayloadJson)(text);
        const body = Option6.match(payload, {
          onNone: () => text,
          onSome: (value) => value.body
        });
        const record = Schema57.decodeOption(Schema57.fromJsonString(Turn))(body);
        if (Option6.isSome(record) && record.value.agent === name && record.value.session === session && (last === null || record.value.at > last.at)) {
          last = {
            at: record.value.at,
            state: record.value.state,
            turnId: record.value.turnId
          };
        }
      }
      ({ cursor } = output);
      if (output.events.length < 100) {
        return last;
      }
    }
    return yield* new MailboxClientError({
      reason: "Turn record scan exceeded 100 pages"
    });
  },
  (effect) => effect.pipe(timeout("10 seconds"), Effect34.mapError(clientError))
);

// packages/mailbox-client/src/prepare.ts
var ownBrand = /* @__PURE__ */ Symbol("OwnIdentity");
var identities = /* @__PURE__ */ new WeakMap();
var ownIdentity = Effect35.fn("Mailbox.ownIdentity")(
  function* ownIdentity2(value) {
    const identity = yield* Schema58.decodeUnknownEffect(Identity2)(value).pipe(
      Effect35.mapError(clientError)
    );
    yield* importSigning(identity).pipe(Effect35.mapError(clientError));
    const handle = Object.freeze({
      [ownBrand]: true
    });
    identities.set(handle, identity);
    return handle;
  }
);
var SendOutcomes = Data2.taggedEnum();
var PreparedMailbox = class extends Context12.Service()("mailbox/PreparedMailbox") {
};
var seal3 = Effect35.fn("Mailbox.sealPayload")(function* seal4(to, body, opts) {
  const client = yield* PreparedMailbox;
  return yield* client.sealPayload(to, body, opts);
});
var sendSealed = Effect35.fn("Mailbox.sendSealed")(function* sendSealed2(envelope, fence) {
  const client = yield* PreparedMailbox;
  return yield* client.sendSealed(envelope, fence);
});
var failure2 = (reason) => new MailboxClientError({ reason });
var directIntent = { wakeReason: "to", woke: true };
var sameDocument = (a, b) => base64url2(canonical(a)) === base64url2(canonical(b));
var prepare = Effect35.fn("Mailbox.prepare")(function* prepare2(options) {
  const identity = identities.get(options.own);
  if (identity === void 0) {
    return yield* failure2("Unknown own identity handle");
  }
  const peers = /* @__PURE__ */ new Map();
  for (const value of options.peers) {
    const peer = yield* Schema58.decodeUnknownEffect(Document)(value).pipe(
      Effect35.mapError(clientError)
    );
    const existing = peers.get(peer.id);
    if (existing !== void 0 && !sameDocument(existing, peer)) {
      return yield* failure2("Conflicting peer documents");
    }
    peers.set(peer.id, peer);
  }
  const resolverLayer = documentResolver(
    (did) => Effect35.sync(() => peers.get(did))
  );
  const config = {
    documents: yield* Schema58.decodeUnknownEffect(
      Schema58.Array(Schema58.toType(DidDocument))
    )(options.peers).pipe(Effect35.mapError(clientError)),
    endpoint: options.endpoint,
    identity,
    serviceDid: options.serviceDid
  };
  if (options.onRetryMetric !== void 0) {
    Object.assign(config, { onRetryMetric: options.onRetryMetric });
  }
  const authLayer = transportLayer(
    options.endpoint,
    `${options.serviceDid.replace(/#mailbox$/u, "")}#mailbox`,
    identity
  );
  const context = yield* Layer6.build(
    clientLayer.pipe(Layer6.provide(authLayer))
  );
  const client = Context12.get(context, MailboxClient);
  const transportContext = yield* Layer6.build(authLayer);
  const transport = Context12.get(transportContext, Transport);
  const resolverContext = yield* Layer6.build(resolverLayer);
  const resolver = Context12.get(resolverContext, DidResolver);
  const mailboxContext = yield* Layer6.build(layer(config, resolverLayer));
  const mailbox = Context12.get(mailboxContext, RatKingMailbox);
  const signingKey = yield* importSigning(identity).pipe(
    Effect35.mapError(clientError)
  );
  const payloads = /* @__PURE__ */ new WeakMap();
  const copies = /* @__PURE__ */ new WeakMap();
  let consuming = false;
  const sealEnvelopeForPeer = Effect35.fn("Mailbox.seal")(
    function* sealEnvelopeForPeer2(to, body, opts) {
      const now = yield* Clock7.currentTimeMillis;
      const messageId = randomTid(now);
      const text = yield* Effect35.try({
        catch: () => new MailboxClientError({ reason: "Invalid message body factory" }),
        try: () => Match4.value(body).pipe(
          Match4.when(Match4.string, (value) => value),
          Match4.orElse((factory) => factory(messageId))
        )
      });
      const raw = {
        aad: {
          messageId,
          recipientDid: to,
          recipientKeyId: `${to}#encryption`,
          senderDid: identity.did
        },
        body: new TextEncoder().encode(text),
        suite: opts?.encrypt === false ? plaintextSuite : suite,
        version: 1
      };
      if (opts?.expiresAt !== void 0) {
        Object.assign(raw.aad, { expiresAt: opts.expiresAt });
      }
      if (opts?.replyTo !== void 0) {
        Object.assign(raw, { replyTo: opts.replyTo });
      }
      if (opts?.urgent !== void 0) {
        Object.assign(raw, { urgent: opts.urgent });
      }
      const payload = yield* Schema58.decodeUnknownEffect(
        Schema58.toType(SigningPayload)
      )(raw).pipe(Effect35.mapError(clientError));
      const envelope = yield* seal({
        payload,
        recipientKey: yield* resolver.resolve(
          to,
          `${to}#encryption`,
          "keyAgreement"
        ),
        recipientKeyId: `${to}#encryption`,
        signingKey,
        signingKeyId: `${identity.did}#atproto`
      }).pipe(Effect35.mapError(clientError));
      payloads.set(envelope, payload);
      return envelope;
    }
  );
  const submit = Effect35.fn("Mailbox.sendSealed")(function* submit2(envelope, fence, intent = directIntent) {
    if (envelope.aad.senderDid !== identity.did || fence !== void 0 && fence.did !== identity.did) {
      return SendOutcomes.NotAttempted({
        reason: "Sender identity or fence mismatch"
      });
    }
    const raw = { envelope, ...intent };
    if (fence !== void 0) {
      Object.assign(raw, {
        generation: fence.generation,
        leaseId: fence.leaseId
      });
    }
    const decoded = yield* Schema58.decodeUnknownEffect(
      Schema58.toType(Input9)
    )(raw).pipe(Effect35.mapError(clientError), Effect35.result);
    if (Result4.isFailure(decoded)) {
      return SendOutcomes.NotAttempted({ reason: decoded.failure.reason });
    }
    const result = yield* client.send(decoded.success).pipe(Effect35.mapError(clientError), Effect35.result);
    if (Result4.isSuccess(result)) {
      return SendOutcomes.Accepted({ receipt: result.success.receipt });
    }
    const error = result.failure;
    return error.status !== void 0 && error.status >= 400 && error.status < 500 ? SendOutcomes.Rejected({ error }) : SendOutcomes.Uncertain({ error });
  });
  const send = Effect35.fn("Mailbox.send")(
    function* send2(envelope, opts) {
      if (!peers.has(envelope.aad.recipientDid)) {
        return SendOutcomes.NotAttempted({ reason: "Unknown primary peer" });
      }
      const intent = {
        wakeReason: opts?.wakeReason ?? "to",
        woke: opts?.woke ?? true
      };
      if (opts?.critical !== void 0) {
        Object.assign(intent, { critical: opts.critical });
      }
      const primary = yield* submit(envelope, opts?.fence, intent);
      if (opts?.cc === void 0) {
        return primary;
      }
      if (plaintext(envelope)) {
        return {
          ...primary,
          cc: SendOutcomes.NotAttempted({
            reason: "Plaintext primary is readable by observers without a CC"
          })
        };
      }
      const payload = payloads.get(envelope);
      const did = opts.cc;
      if (payload === void 0 || !peers.has(did) || did === envelope.aad.recipientDid || !Predicate2.isTagged(primary, "Accepted")) {
        return {
          ...primary,
          cc: SendOutcomes.NotAttempted({
            reason: "CC requires an accepted locally sealed primary and a distinct known peer"
          })
        };
      }
      const ccResult = yield* Effect35.gen(function* carbonCopy() {
        const cached = copies.get(envelope) ?? /* @__PURE__ */ new Map();
        let copy = cached.get(did);
        if (copy === void 0) {
          const body = JSON.stringify({
            $type: "sh.mschf.ratking.mailbox.cc",
            body: new TextDecoder().decode(payload.body),
            primary: {
              messageId: envelope.aad.messageId,
              recipientDid: envelope.aad.recipientDid,
              senderDid: identity.did
            }
          });
          const replyTo = yield* Schema58.decodeUnknownEffect(
            Schema58.toType(MessageRef)
          )({
            messageId: envelope.aad.messageId,
            senderDid: identity.did
          }).pipe(Effect35.mapError(clientError));
          copy = yield* sealEnvelopeForPeer(did, body, { replyTo });
          cached.set(did, copy);
          copies.set(envelope, cached);
        }
        return yield* submit(copy, opts?.fence, {
          wakeReason: "cc",
          woke: false
        });
      }).pipe(
        Effect35.mapError(clientError),
        Effect35.catch(
          (error) => Effect35.succeed(SendOutcomes.NotAttempted({ reason: error.reason }))
        )
      );
      return { ...primary, cc: ccResult };
    },
    timeoutOrElse({
      duration: OPERATION_MS,
      orElse: () => Effect35.succeed(
        SendOutcomes.Uncertain({
          error: new MailboxClientError({
            reason: "Send deadline exceeded; admission may have reached the mailbox"
          })
        })
      )
    })
  );
  const sealPayload = Effect35.fn("Mailbox.sealPayload")(function* sealPayload2(to, body, opts) {
    const from = options.names?.from;
    const recipient = options.names?.peers[to];
    if (from === void 0 || recipient === void 0) {
      return yield* failure2(
        "Payload sealing requires sender and recipient names"
      );
    }
    const envelope = yield* sealEnvelopeForPeer(
      to,
      (id) => {
        const payload = {
          body,
          cc: [],
          from,
          kind: opts?.replyTo === void 0 ? "message" : "reply",
          thread: opts?.thread ?? id,
          to: recipient
        };
        if (opts?.summary !== void 0) {
          Object.assign(payload, { summary: opts.summary });
        }
        if (opts?.replyTo !== void 0) {
          Object.assign(payload, { replyTo: opts.replyTo.messageId });
        }
        return Schema58.encodeSync(PayloadJson)(payload);
      },
      opts
    ).pipe(Effect35.mapError(clientError));
    return { envelope, messageId: envelope.aad.messageId };
  });
  const refresh = Effect35.fn("Mailbox.refresh")(
    function* refresh2(did) {
      const params = yield* Schema58.decodeUnknownEffect(Params17)({
        did
      }).pipe(Effect35.mapError(clientError));
      const response = yield* transport.request({
        input: void 0,
        method: "GET",
        nsid: Method16.nsid,
        params: yield* Schema58.encodeEffect(Params17)(params).pipe(
          Effect35.mapError(clientError)
        )
      }).pipe(Effect35.mapError(clientError));
      if (response.kind !== "json" || response.status !== 200) {
        return yield* new MailboxClientError({
          reason: "Peer directory request refused",
          status: response.status
        });
      }
      const output = yield* Schema58.decodeUnknownEffect(Output15)(
        response.body
      ).pipe(Effect35.mapError(clientError));
      const peer = yield* Schema58.decodeUnknownEffect(Document)(
        output.document
      ).pipe(Effect35.mapError(clientError));
      const existing = peers.get(did);
      if (peer.id !== did || existing !== void 0 && !sameDocument(existing, peer)) {
        return yield* failure2(
          "Peer directory conflict; retained trusted document"
        );
      }
      peers.set(did, peer);
      return peer;
    },
    (effect) => effect.pipe(
      timeout(REQUEST_MS),
      Effect35.mapError(clientError)
    )
  );
  const presence = (did) => lookupPresence(did).pipe(Effect35.provideService(Transport, transport));
  return {
    consume: (handler, opts) => Effect35.suspend(() => {
      if (consuming) {
        return Effect35.fail(failure2("Consumer already active"));
      }
      consuming = true;
      const consumeOptions = { ...opts };
      if (consumeOptions.onRetryMetric === void 0 && options.onRetryMetric !== void 0) {
        Object.assign(consumeOptions, {
          onRetryMetric: options.onRetryMetric
        });
      }
      return consume(mailbox, identity.did, handler, consumeOptions).pipe(
        Effect35.ensuring(
          Effect35.sync(() => {
            consuming = false;
          })
        )
      );
    }),
    head: mailbox.list({ afterSeq: 0, limit: 1 }).pipe(Effect35.map(({ throughSeq }) => throughSeq)),
    health: (did, name) => readMailboxHealth(transport, did, name),
    mailbox,
    open: mailbox.open,
    presence,
    refresh,
    resolveLease: mailbox.lease.resolve,
    seal: sealEnvelopeForPeer,
    sealPayload,
    send,
    sendSealed: submit,
    turnHealth: (did, name, session) => readTurnHealth(transport, did, name, session)
  };
});
export {
  AgentName,
  Claims,
  DidResolver,
  Document,
  Documents,
  Identity2 as Identity,
  Kind,
  MailboxClientError,
  Payload,
  PayloadJson,
  PreparedMailbox,
  PrivateJwk,
  RatKingMailbox,
  ReplayAuthority,
  SUMMARY_HARD_MAX,
  SUMMARY_MAX,
  SUMMARY_WIRE_MAX,
  SendOutcomes,
  WebSocketPort,
  attentionBytes,
  authenticateClaims,
  base64url2 as base64url,
  consumerMachine,
  defaultPreferences,
  defaultStatus,
  documentResolver,
  encodePayload,
  fromBasisPoints,
  importAgreement,
  importSigning,
  layer,
  lookupPresence,
  ownIdentity,
  prepare,
  readerCannotRender,
  recordType,
  seal3 as seal,
  sendSealed,
  serviceToken,
  staticResolver,
  tid,
  toBasisPoints,
  transportLayer,
  unbase64url
};
