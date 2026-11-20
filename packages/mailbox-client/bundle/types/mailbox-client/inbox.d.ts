import type { Request } from "../lexicon/transport.js";
import { Effect } from "effect";
import { MailboxClientError } from "./error.js";
export declare const listPage: (transport: {
    readonly request: (request: Request) => Effect.Effect<import("../lexicon/transport.js").Response, import("../lexicon/transport-failure.js").TransportFailure>;
}, params: {
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly afterSeq?: number;
    readonly beforeSeq?: number;
    readonly limit?: number;
    readonly recipientDid: string & import("effect/Brand").Brand<"Lexicon:did">;
}) => Effect.Effect<{
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly events: readonly ({
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly $type: string;
    } | {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly $type: "sh.mschf.ratking.defs#messageEvent";
        readonly envelope: {
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
        };
        readonly receipt: {
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
        };
        readonly seq: number;
    } | {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly $type: "sh.mschf.ratking.defs#receiptEvent";
        readonly receipt: {
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
        };
        readonly seq: number;
    } | {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly $type: "sh.mschf.ratking.attention.receipt";
        readonly operation: "putPreferences" | "putStatus";
        readonly seq: number;
    })[];
    readonly latestSeq: number;
    readonly messages?: readonly {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly admissionSeq: number;
        readonly envelope: {
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
        };
        readonly receipt: {
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
        };
    }[];
    readonly nextAfterSeq?: number;
    readonly nextBeforeSeq?: number;
}, MailboxClientError, never>;
export declare const markRead: (transport: {
    readonly request: (request: Request) => Effect.Effect<import("../lexicon/transport.js").Response, import("../lexicon/transport-failure.js").TransportFailure>;
}, input: {
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly recipientDid: string & import("effect/Brand").Brand<"Lexicon:did">;
    readonly upToSeq: number;
}) => Effect.Effect<{
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly marked: number;
    readonly more: boolean;
}, MailboxClientError, never>;
