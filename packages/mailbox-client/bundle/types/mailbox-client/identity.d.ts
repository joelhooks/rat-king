import type { EnvelopeFailure, RecipientOpener } from "../envelope/envelope.js";
import type { Es256Signer } from "../envelope/es256.js";
import { Effect, Schema } from "effect";
export declare const PublicJwk: Schema.Struct<{
    readonly crv: Schema.Literal<"P-256">;
    readonly kty: Schema.Literal<"EC">;
    readonly x: Schema.String;
    readonly y: Schema.String;
}>;
export declare const PrivateJwk: Schema.Struct<{
    readonly crv: Schema.Literal<"P-256">;
    readonly kty: Schema.Literal<"EC">;
    readonly x: Schema.String;
    readonly y: Schema.String;
    readonly d: Schema.String;
}>;
export declare const Identity: Schema.Struct<{
    readonly agreement: Schema.Struct<{
        readonly crv: Schema.Literal<"P-256">;
        readonly kty: Schema.Literal<"EC">;
        readonly x: Schema.String;
        readonly y: Schema.String;
        readonly d: Schema.String;
    }>;
    readonly did: Schema.String;
    readonly signing: Schema.Struct<{
        readonly crv: Schema.Literal<"P-256">;
        readonly kty: Schema.Literal<"EC">;
        readonly x: Schema.String;
        readonly y: Schema.String;
        readonly d: Schema.String;
    }>;
}>;
export type IdentityValue = typeof Identity.Type;
export interface ManagedIdentity {
    readonly agreement: typeof PublicJwk.Type;
    readonly did: string;
    readonly signing: typeof PublicJwk.Type;
    readonly sign: Es256Signer;
    readonly open: RecipientOpener;
}
export type RuntimeIdentity = IdentityValue | ManagedIdentity;
export declare const importSigning: (identity: IdentityValue) => Effect.Effect<CryptoKey, EnvelopeFailure, never>;
export declare const importAgreement: (identity: IdentityValue) => Effect.Effect<CryptoKey, EnvelopeFailure, never>;
export declare const signingFor: (identity: RuntimeIdentity) => Effect.Effect<CryptoKey | Es256Signer, EnvelopeFailure>;
export declare const recipientFor: (identity: RuntimeIdentity) => Effect.Effect<CryptoKey | RecipientOpener, EnvelopeFailure>;
