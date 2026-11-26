import type { Es256Signer } from "../envelope/es256.js";
import type { XrpcFailure } from "../lexicon/xrpc-failure.js";
import { Context, Effect, Layer, Schema } from "effect";
import { ReplayAuthority } from "./replay.js";
export { sign, verify, lowS, normalizeSignature, p256Order, } from "../envelope/es256.js";
export { ReplayAuthority } from "./replay.js";
export { ServiceAuthFailure } from "./auth-failure.js";
export type { ReplayInterface } from "./replay.js";
export declare const base64url: (bytes: Uint8Array) => string;
export declare const unbase64url: (text: string) => Uint8Array<ArrayBuffer>;
export declare const Claims: Schema.Struct<{
    readonly aud: Schema.String;
    readonly exp: Schema.Int;
    readonly iat: Schema.Int;
    readonly iss: Schema.String;
    readonly jti: Schema.String;
    readonly lxm: Schema.String;
}>;
export type ClaimsValue = typeof Claims.Type;
type ClaimsCheck = "aud" | "lxm" | "iat-future" | "expired" | "exp-before-iat" | "lifetime" | "stale";
interface ClaimsDiagnostics {
    readonly check: ClaimsCheck;
    readonly claimedIssuer: ClaimsValue["iss"];
}
export declare const getClaimsDiagnostics: (error: XrpcFailure) => ClaimsDiagnostics | undefined;
export declare const Document: Schema.Struct<{
    readonly authentication: Schema.$Array<Schema.String>;
    readonly id: Schema.String;
    readonly keyAgreement: Schema.$Array<Schema.String>;
    readonly verificationMethod: Schema.$Array<Schema.Struct<{
        readonly controller: Schema.String;
        readonly id: Schema.String;
        readonly publicKeyJwk: Schema.Struct<{
            readonly crv: Schema.Literal<"P-256">;
            readonly d: Schema.optionalKey<Schema.Never>;
            readonly kty: Schema.Literal<"EC">;
            readonly x: Schema.String;
            readonly y: Schema.String;
        }>;
    }>>;
}>;
export declare const Documents: Schema.$Array<Schema.Struct<{
    readonly authentication: Schema.$Array<Schema.String>;
    readonly id: Schema.String;
    readonly keyAgreement: Schema.$Array<Schema.String>;
    readonly verificationMethod: Schema.$Array<Schema.Struct<{
        readonly controller: Schema.String;
        readonly id: Schema.String;
        readonly publicKeyJwk: Schema.Struct<{
            readonly crv: Schema.Literal<"P-256">;
            readonly d: Schema.optionalKey<Schema.Never>;
            readonly kty: Schema.Literal<"EC">;
            readonly x: Schema.String;
            readonly y: Schema.String;
        }>;
    }>>;
}>>;
export type DocumentsValue = typeof Documents.Type;
declare const DidResolver_base: Context.ServiceClass<DidResolver, "mailbox/DidResolver", {
    readonly resolve: (did: string, keyId: string, purpose: "authentication" | "keyAgreement") => Effect.Effect<CryptoKey, XrpcFailure>;
}>;
export declare class DidResolver extends DidResolver_base {
}
export declare const documentResolver: (lookup: (did: string) => Effect.Effect<typeof Document.Type | undefined, XrpcFailure>) => Layer.Layer<DidResolver, never, never>;
export declare const staticResolver: (documents: DocumentsValue) => Layer.Layer<DidResolver, never, never>;
export interface AuthenticateRequest {
    readonly authorization: string | null;
    readonly audience: string;
    readonly nsid: string;
    readonly now: number;
    readonly skewSeconds?: number;
}
export declare const authenticateClaims: (request: AuthenticateRequest) => Effect.Effect<{
    readonly aud: string;
    readonly exp: number;
    readonly iat: number;
    readonly iss: string;
    readonly jti: string;
    readonly lxm: string;
}, XrpcFailure, DidResolver | ReplayAuthority>;
export declare const serviceToken: (claims: {
    readonly aud: string;
    readonly exp: number;
    readonly iat: number;
    readonly iss: string;
    readonly jti: string;
    readonly lxm: string;
}, key: CryptoKey | Es256Signer, kid?: string | undefined) => Effect.Effect<string, import("../envelope/envelope.js").EnvelopeFailure, never>;
