import { EnvelopeFailure } from "../envelope/envelope.js";
import type { ResolveSigningKey } from "../envelope/signed.js";
import { Effect, Schema } from "effect";
export declare const openDelegated: (envelope: {
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
}, receipt: {
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly delegated?: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly to: string;
        readonly until?: string & import("effect/Brand").Brand<"Lexicon:datetime">;
    };
    readonly delegatedFor?: string;
    readonly delegatedTo?: string;
    readonly detail?: string;
    readonly message: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly cid?: string & import("effect/Brand").Brand<"Lexicon:cid">;
        readonly messageId: string & import("effect/Brand").Brand<"Lexicon:tid">;
        readonly senderDid: string & import("effect/Brand").Brand<"Lexicon:did">;
        readonly uri?: string & import("effect/Brand").Brand<"Lexicon:at-uri">;
    };
    readonly originalId?: string & import("effect/Brand").Brand<"Lexicon:tid">;
    readonly recipientDid: string & import("effect/Brand").Brand<"Lexicon:did">;
    readonly recordedAt?: string & import("effect/Brand").Brand<"Lexicon:datetime">;
    readonly resolvedFrom?: string;
    readonly seq: number;
    readonly state: string;
    readonly via?: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly desk: string;
        readonly deskDid: string & import("effect/Brand").Brand<"Lexicon:did">;
        readonly pass: {
            readonly [x: string]: import("../lexicon/runtime.js").LexValue;
            readonly record: {
                readonly [x: string]: import("../lexicon/runtime.js").LexValue;
                readonly $type: "sh.ratking.pass";
                readonly desk: string;
                readonly deskDid: string & import("effect/Brand").Brand<"Lexicon:did">;
                readonly exp: number;
                readonly iat: number;
                readonly nonce: string;
                readonly run: string;
                readonly scope: readonly string[];
                readonly v: 1;
                readonly worker: string & import("effect/Brand").Brand<"Lexicon:did">;
            };
            readonly signature: string;
        };
        readonly run: string;
        readonly worker: string & import("effect/Brand").Brand<"Lexicon:did">;
    };
    readonly wakeReason?: string;
    readonly woke?: boolean;
}, recipientDid: string, resolveSigningKey: ResolveSigningKey) => Effect.Effect<{
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
