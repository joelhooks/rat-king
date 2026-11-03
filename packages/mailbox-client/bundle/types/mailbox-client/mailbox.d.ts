import * as Put from "../lexicon/admin.putDidDocument.js";
import * as Defs from "../lexicon/defs.js";
import * as Ack from "../lexicon/mailbox.ack.js";
import * as Deliver from "../lexicon/mailbox.deliver.js";
import * as List from "../lexicon/mailbox.list.js";
import * as Send from "../lexicon/mailbox.send.js";
import type * as Lease from "../lexicon/runtime.lease.js";
import { Context, Effect, Layer } from "effect";
import type { Stream } from "effect";
import type { HttpClient } from "effect/http";
import type { AttentionClient } from "./attention.js";
import { DidResolver } from "./auth.js";
import { MailboxClientError } from "./error.js";
import type { IdentityValue } from "./identity.js";
import type { RetryObserver } from "./retry-metrics.js";
export { Identity, PrivateJwk, importSigning, importAgreement, } from "./identity.js";
export type { IdentityValue } from "./identity.js";
export { MailboxClientError } from "./error.js";
export { base64url, unbase64url, Claims, Document, Documents, documentResolver, DidResolver, staticResolver, serviceToken, } from "./auth.js";
export type { ClaimsValue, DocumentsValue } from "./auth.js";
export { tid } from "./tid.js";
export { transportLayer } from "./transport.js";
export { WebSocketPort } from "./watch.js";
export interface ClientConfig {
    readonly onRetryMetric?: RetryObserver;
    readonly endpoint: string;
    readonly serviceDid: string;
    readonly identity: IdentityValue;
    readonly documents: readonly Defs.DidDocumentValue[];
}
export interface LeaseFence {
    readonly did: string;
    readonly leaseId: string;
    readonly generation: number;
}
export declare const POLL_MAX_PAGES = 10;
export interface Batch {
    readonly hasMore?: boolean;
    readonly events: List.OutputValue["events"];
    readonly throughSeq: number;
}
export interface OpenedMessage {
    readonly via?: Pick<Defs.ViaValue, "desk" | "deskDid" | "run">;
    readonly delegatedFor?: string;
    readonly delegatedTo?: string;
    readonly originalId?: string;
    readonly senderDid: Defs.AadValue["senderDid"];
    readonly tid: Defs.AadValue["messageId"];
    readonly body: string;
    readonly replyTo?: Defs.MessageRefValue;
    readonly urgent?: true;
    readonly verified: true;
    readonly encrypted?: boolean;
    readonly cc?: {
        readonly senderDid: string;
        readonly messageId: string;
        readonly recipientDid: string;
    };
}
export interface SendOptions {
    readonly critical?: boolean;
    readonly woke?: boolean;
    readonly wakeReason?: Send.InputValue["wakeReason"];
    readonly recordType?: string;
    readonly replyTo?: Defs.MessageRefValue;
    readonly expiresAt?: string;
    readonly fence?: LeaseFence;
    readonly urgent?: true;
    readonly encrypt?: boolean;
}
export interface FencedMessage {
    readonly message: Defs.MessageRefValue;
    readonly leaseId: string;
    readonly generation: number;
}
export interface AcquireRequest {
    readonly did: string;
    readonly harness: Lease.MainValue["harness"];
    readonly renders?: readonly string[];
    readonly expiresAt: string;
    readonly leaseId?: string;
    readonly generation?: number;
}
declare const RatKingMailbox_base: Context.ServiceClass<RatKingMailbox, "@rat-king/mailbox-client/RatKingMailbox", {
    readonly getPreferences: AttentionClient["getPreferences"];
    readonly getStatus: AttentionClient["getStatus"];
    readonly putPreferences: AttentionClient["putPreferences"];
    readonly putStatus: AttentionClient["putStatus"];
    readonly send: (to: string, body: string, opts?: SendOptions) => Effect.Effect<Send.OutputValue, MailboxClientError>;
    readonly list: (params: {
        readonly afterSeq?: number;
        readonly cursor?: string;
        readonly limit?: number;
    }) => Effect.Effect<List.OutputValue, MailboxClientError>;
    readonly poll: (afterSeq: number) => Effect.Effect<Batch, MailboxClientError>;
    readonly watch: (afterSeq: number, fence: LeaseFence, onRetry?: (error: MailboxClientError) => Effect.Effect<void>) => Stream.Stream<Batch, MailboxClientError>;
    readonly open: (envelope: Defs.EncryptedEnvelopeValue, receipt?: Defs.ReceiptValue) => Effect.Effect<OpenedMessage, MailboxClientError>;
    readonly deliver: (input: FencedMessage) => Effect.Effect<Deliver.OutputValue, MailboxClientError>;
    readonly ack: (input: FencedMessage) => Effect.Effect<Ack.OutputValue, MailboxClientError>;
    readonly lease: {
        readonly acquire: (input: AcquireRequest) => Effect.Effect<Lease.MainValue, MailboxClientError>;
        readonly renew: (input: LeaseFence & {
            readonly expiresAt: string;
            readonly renders?: readonly string[];
        }) => Effect.Effect<Lease.MainValue, MailboxClientError>;
        readonly resolve: (did: string) => Effect.Effect<Lease.MainValue, MailboxClientError>;
        readonly release: (input: LeaseFence) => Effect.Effect<void, MailboxClientError>;
    };
    readonly putDidDocument: (document: Defs.DidDocumentValue) => Effect.Effect<Put.OutputValue, MailboxClientError>;
}>;
export declare class RatKingMailbox extends RatKingMailbox_base {
}
export declare const layer: (config: ClientConfig, resolverLayer?: Layer.Layer<DidResolver, never, never>) => Layer.Layer<RatKingMailbox, never, HttpClient.HttpClient>;
