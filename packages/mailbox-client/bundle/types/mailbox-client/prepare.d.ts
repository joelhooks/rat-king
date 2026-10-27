import * as Defs from "../lexicon/defs.js";
import * as Send from "../lexicon/mailbox.send.js";
import { Context, Data, Effect } from "effect";
import { Document } from "./auth.js";
import type { ConsumeOptions, MessageMeta } from "./consume.js";
import { MailboxClientError } from "./error.js";
import type { LeaseFence, OpenedMessage, SendOptions } from "./mailbox.js";
import type { RetryObserver } from "./retry-metrics.js";
declare const ownBrand: unique symbol;
export interface OwnIdentity {
    readonly [ownBrand]: true;
}
export declare const ownIdentity: (value: {
    readonly agreement: {
        readonly crv: "P-256";
        readonly d: string;
        readonly kty: "EC";
        readonly x: string;
        readonly y: string;
    };
    readonly did: string;
    readonly signing: {
        readonly crv: "P-256";
        readonly d: string;
        readonly kty: "EC";
        readonly x: string;
        readonly y: string;
    };
}) => Effect.Effect<OwnIdentity, MailboxClientError, never>;
export type PeerDocument = typeof Document.Type;
export type SendOutcome = {
    readonly _tag: "NotAttempted";
    readonly reason: string;
} | {
    readonly _tag: "Rejected";
    readonly error: MailboxClientError;
} | {
    readonly _tag: "Accepted";
    readonly receipt: Send.OutputValue["receipt"];
} | {
    readonly _tag: "Uncertain";
    readonly error: MailboxClientError;
};
export declare const SendOutcomes: {
    readonly $is: <Tag extends "Accepted" | "NotAttempted" | "Rejected" | "Uncertain">(tag: Tag) => (u: unknown) => u is Extract<{
        readonly _tag: "NotAttempted";
        readonly reason: string;
    }, {
        readonly _tag: Tag;
    }> | Extract<{
        readonly _tag: "Rejected";
        readonly error: MailboxClientError;
    }, {
        readonly _tag: Tag;
    }> | Extract<{
        readonly _tag: "Accepted";
        readonly receipt: Send.OutputValue["receipt"];
    }, {
        readonly _tag: Tag;
    }> | Extract<{
        readonly _tag: "Uncertain";
        readonly error: MailboxClientError;
    }, {
        readonly _tag: Tag;
    }>;
    readonly $match: {
        <Cases extends { readonly [Tag in "Accepted" | "NotAttempted" | "Rejected" | "Uncertain"]: (args: Extract<SendOutcome, {
            readonly _tag: Tag;
        }>) => any; }>(cases: Cases): (value: SendOutcome) => import("effect/Unify").Unify<ReturnType<Cases["Accepted" | "NotAttempted" | "Rejected" | "Uncertain"]>>;
        <Cases extends { readonly [Tag in "Accepted" | "NotAttempted" | "Rejected" | "Uncertain"]: (args: Extract<SendOutcome, {
            readonly _tag: Tag;
        }>) => any; }>(value: SendOutcome, cases: Cases): import("effect/Unify").Unify<ReturnType<Cases["Accepted" | "NotAttempted" | "Rejected" | "Uncertain"]>>;
    };
    readonly Accepted: Data.TaggedEnum.ConstructorFrom<{
        readonly _tag: "Accepted";
        readonly receipt: Send.OutputValue["receipt"];
    }, "_tag">;
    readonly NotAttempted: Data.TaggedEnum.ConstructorFrom<{
        readonly _tag: "NotAttempted";
        readonly reason: string;
    }, "_tag">;
    readonly Rejected: Data.TaggedEnum.ConstructorFrom<{
        readonly _tag: "Rejected";
        readonly error: MailboxClientError;
    }, "_tag">;
    readonly Uncertain: Data.TaggedEnum.ConstructorFrom<{
        readonly _tag: "Uncertain";
        readonly error: MailboxClientError;
    }, "_tag">;
};
export type SendResult = SendOutcome & {
    readonly cc?: SendOutcome;
};
export interface SealOptions {
    readonly encrypt?: boolean;
    readonly replyTo?: Defs.MessageRefValue;
    readonly summary?: string;
    readonly thread?: string;
}
export interface SealedMessage {
    readonly envelope: Defs.EncryptedEnvelopeValue;
    readonly messageId: string;
}
declare const PreparedMailbox_base: Context.ServiceClass<PreparedMailbox, "mailbox/PreparedMailbox", {
    readonly sealPayload: (to: string, body: string, opts?: SealOptions) => Effect.Effect<SealedMessage, MailboxClientError>;
    readonly sendSealed: (envelope: Defs.EncryptedEnvelopeValue, fence?: LeaseFence) => Effect.Effect<SendOutcome>;
}>;
export declare class PreparedMailbox extends PreparedMailbox_base {
}
export declare const seal: (to: string, body: string, opts?: SealOptions | undefined) => Effect.Effect<SealedMessage, MailboxClientError, PreparedMailbox>;
export declare const sendSealed: (envelope: {
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
}, fence?: LeaseFence | undefined) => Effect.Effect<SendOutcome, never, PreparedMailbox>;
export interface PrepareOptions {
    readonly onRetryMetric?: RetryObserver;
    readonly own: OwnIdentity;
    readonly names?: {
        readonly from: string;
        readonly peers: Readonly<Record<string, string>>;
    };
    readonly peers: readonly PeerDocument[];
    readonly endpoint: string;
    readonly serviceDid: string;
}
export declare const prepare: (options: PrepareOptions) => Effect.Effect<{
    consume: <E, R>(handler: (message: OpenedMessage, meta: MessageMeta) => Effect.Effect<void, E, R>, opts: ConsumeOptions) => Effect.Effect<void, E | MailboxClientError, R>;
    head: Effect.Effect<number, MailboxClientError, never>;
    health: (did: string, name: string) => Effect.Effect<{
        readonly complete: boolean;
        readonly lastAck: number | null;
        readonly lease: {
            readonly expiresAt: number;
            readonly generation: number;
            readonly holder: string;
            readonly pane: string | null;
        } | null;
        readonly oldestWake: {
            readonly at: number;
            readonly id: string;
            readonly sender: string;
        } | null;
        readonly oldestWakeSinceAck?: {
            readonly at: number;
            readonly id: string;
            readonly sender: string;
        } | null;
        readonly quietUnacked: number;
    }, MailboxClientError, never>;
    mailbox: {
        readonly getPreferences: import("./attention.js").AttentionClient["getPreferences"];
        readonly getStatus: import("./attention.js").AttentionClient["getStatus"];
        readonly putPreferences: import("./attention.js").AttentionClient["putPreferences"];
        readonly putStatus: import("./attention.js").AttentionClient["putStatus"];
        readonly send: (to: string, body: string, opts?: SendOptions) => Effect.Effect<Send.OutputValue, MailboxClientError>;
        readonly list: (params: {
            readonly afterSeq?: number;
            readonly cursor?: string;
            readonly limit?: number;
        }) => Effect.Effect<import("../lexicon/mailbox.list.js").OutputValue, MailboxClientError>;
        readonly poll: (afterSeq: number) => Effect.Effect<import("./mailbox.js").Batch, MailboxClientError>;
        readonly watch: (afterSeq: number, fence: LeaseFence) => import("effect/Stream").Stream<import("./mailbox.js").Batch, MailboxClientError>;
        readonly open: (envelope: Defs.EncryptedEnvelopeValue, receipt?: Defs.ReceiptValue) => Effect.Effect<OpenedMessage, MailboxClientError>;
        readonly deliver: (input: import("./mailbox.js").FencedMessage) => Effect.Effect<import("../lexicon/mailbox.deliver.js").OutputValue, MailboxClientError>;
        readonly ack: (input: import("./mailbox.js").FencedMessage) => Effect.Effect<import("../lexicon/mailbox.ack.js").OutputValue, MailboxClientError>;
        readonly lease: {
            readonly acquire: (input: import("./mailbox.js").AcquireRequest) => Effect.Effect<import("../lexicon/runtime.lease.js").MainValue, MailboxClientError>;
            readonly renew: (input: LeaseFence & {
                readonly expiresAt: string;
                readonly renders?: readonly string[];
            }) => Effect.Effect<import("../lexicon/runtime.lease.js").MainValue, MailboxClientError>;
            readonly resolve: (did: string) => Effect.Effect<import("../lexicon/runtime.lease.js").MainValue, MailboxClientError>;
            readonly release: (input: LeaseFence) => Effect.Effect<void, MailboxClientError>;
        };
        readonly putDidDocument: (document: Defs.DidDocumentValue) => Effect.Effect<import("../lexicon/admin.putDidDocument.js").OutputValue, MailboxClientError>;
    };
    open: (envelope: Defs.EncryptedEnvelopeValue, receipt?: Defs.ReceiptValue) => Effect.Effect<OpenedMessage, MailboxClientError>;
    presence: (did: string) => Effect.Effect<{
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly did: string & import("effect/Brand").Brand<"Lexicon:did">;
        readonly held: boolean;
        readonly lastHeldAt?: string & import("effect/Brand").Brand<"Lexicon:datetime">;
        readonly renders?: readonly string[];
    }, MailboxClientError, never>;
    refresh: (did: string) => Effect.Effect<{
        readonly authentication: readonly string[];
        readonly id: string;
        readonly keyAgreement: readonly string[];
        readonly verificationMethod: readonly {
            readonly controller: string;
            readonly id: string;
            readonly publicKeyJwk: {
                readonly crv: "P-256";
                readonly d?: never;
                readonly kty: "EC";
                readonly x: string;
                readonly y: string;
            };
        }[];
    }, MailboxClientError, never>;
    resolveLease: (did: string) => Effect.Effect<import("../lexicon/runtime.lease.js").MainValue, MailboxClientError>;
    seal: (to: string, body: string | ((messageId: string) => string), opts?: SendOptions | undefined) => Effect.Effect<{
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
    }, MailboxClientError | import("../lexicon/xrpc-failure.js").XrpcFailure, never>;
    sealPayload: (to: string, body: string, opts?: SealOptions | undefined) => Effect.Effect<{
        envelope: {
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
        messageId: string & import("effect/Brand").Brand<"Lexicon:tid">;
    }, MailboxClientError, never>;
    send: (envelope: {
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
    }, opts?: {
        readonly cc?: string;
        readonly critical?: boolean;
        readonly fence?: LeaseFence;
        readonly woke?: boolean;
        readonly wakeReason?: Send.InputValue["wakeReason"];
    } | undefined) => Effect.Effect<SendResult, never, never>;
    sendSealed: (envelope: {
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
    }, fence?: LeaseFence | undefined, intent?: {
        readonly critical?: boolean;
        readonly woke: boolean;
        readonly wakeReason: Send.InputValue["wakeReason"];
    } | undefined) => Effect.Effect<{
        readonly _tag: "NotAttempted";
        readonly reason: string;
    } | {
        readonly _tag: "Rejected";
        readonly error: MailboxClientError;
    } | {
        readonly _tag: "Accepted";
        readonly receipt: Send.OutputValue["receipt"];
    } | {
        readonly _tag: "Uncertain";
        readonly error: MailboxClientError;
    }, never, never>;
    turnHealth: (did: string, name: string, session: string) => Effect.Effect<{
        readonly at: string;
        readonly state: string;
        readonly turnId: string;
    } | null, MailboxClientError, never>;
}, MailboxClientError, import("effect/http/HttpClient").HttpClient | import("effect/Scope").Scope>;
export {};
