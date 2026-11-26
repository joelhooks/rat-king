import { CipherSuite } from "@hpke/core";
import * as Defs from "../lexicon/defs.js";
import { Effect, Schema } from "effect";
import type { Es256Signer } from "./es256.js";
import { EnvelopeFailure } from "./failure.js";
import type { ResolveSigningKey } from "./signed.js";
export declare const reviewStatus = "unreviewed";
export declare const hpke: CipherSuite;
export declare const info: Uint8Array<ArrayBuffer>;
export interface SealRequest {
    readonly payload: Defs.SigningPayloadValue;
    readonly signingKeyId: string;
    readonly signingKey: CryptoKey | Es256Signer;
    readonly recipientKeyId: string;
    readonly recipientKey: CryptoKey;
}
export declare const seal: (request: SealRequest) => Effect.Effect<{
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly aad: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly expiresAt?: string & import("effect/Brand").Brand<"Lexicon:datetime">;
        readonly messageId: string & import("effect/Brand").Brand<"Lexicon:tid">;
        readonly recipientDid: string & import("effect/Brand").Brand<"Lexicon:did">;
        readonly recipientKeyId: string & import("effect/Brand").Brand<"Lexicon:uri">;
        readonly senderDid: string & import("effect/Brand").Brand<"Lexicon:did">;
    };
    readonly ciphertext: Uint8Array<ArrayBufferLike>;
    readonly enc: Uint8Array<ArrayBufferLike>;
    readonly suite: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly aeadId: number;
        readonly kdfId: number;
        readonly kemId: number;
    };
    readonly version: number;
}, EnvelopeFailure | Schema.SchemaError, never>;
export type RecipientOpener = (envelope: Defs.EncryptedEnvelopeValue) => Effect.Effect<Uint8Array, EnvelopeFailure>;
export declare const openCiphertext: (key: CryptoKey, envelope: {
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly aad: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly expiresAt?: string & import("effect/Brand").Brand<"Lexicon:datetime">;
        readonly messageId: string & import("effect/Brand").Brand<"Lexicon:tid">;
        readonly recipientDid: string & import("effect/Brand").Brand<"Lexicon:did">;
        readonly recipientKeyId: string & import("effect/Brand").Brand<"Lexicon:uri">;
        readonly senderDid: string & import("effect/Brand").Brand<"Lexicon:did">;
    };
    readonly ciphertext: Uint8Array<ArrayBufferLike>;
    readonly enc: Uint8Array<ArrayBufferLike>;
    readonly suite: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly aeadId: number;
        readonly kdfId: number;
        readonly kemId: number;
    };
    readonly version: number;
}) => Effect.Effect<Uint8Array<ArrayBuffer>, EnvelopeFailure, never>;
export interface OpenRequest {
    readonly envelope: Defs.EncryptedEnvelopeValue;
    readonly recipientDid: string;
    readonly recipientKeyId: string;
    readonly recipientKey: CryptoKey | RecipientOpener;
    readonly resolveSigningKey: ResolveSigningKey;
}
export declare const open: (request: OpenRequest) => Effect.Effect<{
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly aad: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly expiresAt?: string & import("effect/Brand").Brand<"Lexicon:datetime">;
        readonly messageId: string & import("effect/Brand").Brand<"Lexicon:tid">;
        readonly recipientDid: string & import("effect/Brand").Brand<"Lexicon:did">;
        readonly recipientKeyId: string & import("effect/Brand").Brand<"Lexicon:uri">;
        readonly senderDid: string & import("effect/Brand").Brand<"Lexicon:did">;
    };
    readonly body: Uint8Array<ArrayBufferLike>;
    readonly createdAt?: string & import("effect/Brand").Brand<"Lexicon:datetime">;
    readonly replyTo?: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly cid?: string & import("effect/Brand").Brand<"Lexicon:cid">;
        readonly messageId: string & import("effect/Brand").Brand<"Lexicon:tid">;
        readonly senderDid: string & import("effect/Brand").Brand<"Lexicon:did">;
        readonly uri?: string & import("effect/Brand").Brand<"Lexicon:at-uri">;
    };
    readonly suite: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly aeadId: number;
        readonly kdfId: number;
        readonly kemId: number;
    };
    readonly urgent?: true;
    readonly version: number;
}, EnvelopeFailure | Schema.SchemaError, never>;
export { aadBytes, canonical, canonicalDecode, concatenate, equalBytes, plaintext, plaintextEnc, plaintextSuite, signatureDomain, signingBytes, supported, suite, } from "./canonical.js";
export { openPlaintext, verifySigned } from "./signed.js";
export type { ResolveSigningKey } from "./signed.js";
export { lowS, normalizeSignature, p256Order, sign, verify } from "./es256.js";
export { EnvelopeFailure } from "./failure.js";
export { cryptoOperation } from "./webcrypto.js";
