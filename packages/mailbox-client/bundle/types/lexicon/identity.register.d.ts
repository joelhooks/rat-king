import { Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const Params: Schema.Undefined;
export type ParamsValue = typeof Params.Type;
export declare const Input: Schema.StructWithRest<Schema.Struct<{
    readonly document: Schema.StructWithRest<Schema.Struct<{
        readonly authentication: Schema.$Array<Schema.String>;
        readonly id: Schema.brand<Schema.String, "Lexicon:did">;
        readonly keyAgreement: Schema.$Array<Schema.String>;
        readonly verificationMethod: Schema.$Array<Schema.StructWithRest<Schema.Struct<{
            readonly controller: Schema.String;
            readonly id: Schema.String;
            readonly publicKeyJwk: Schema.StructWithRest<Schema.Struct<{
                readonly crv: Schema.compose<Schema.Literal<"P-256">, Schema.String>;
                readonly kty: Schema.compose<Schema.Literal<"EC">, Schema.String>;
                readonly x: Schema.String;
                readonly y: Schema.String;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly name: Schema.String;
    readonly parent: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
        readonly name: Schema.String;
        readonly session: Schema.String;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type InputValue = typeof Input.Type;
export declare const Output: Schema.StructWithRest<Schema.Struct<{
    readonly did: Schema.brand<Schema.String, "Lexicon:did">;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type OutputValue = typeof Output.Type;
export declare const ErrorBody: Schema.StructWithRest<Schema.Struct<{
    readonly error: Schema.String;
    readonly message: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ErrorBodyValue = typeof ErrorBody.Type;
export declare const KnownErrors: readonly ["InvalidRequest", "AuthRequired", "Forbidden", "InvalidName", "NameReserved", "NameTaken", "NameCollision", "DocumentConflict", "MailboxUnavailable"];
export type KnownError = (typeof KnownErrors)[number];
export declare const isKnownError: (value: string) => value is KnownError;
export declare const Method: {
    readonly defaults: {};
    readonly error: Schema.StructWithRest<Schema.Struct<{
        readonly error: Schema.String;
        readonly message: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly input: Schema.StructWithRest<Schema.Struct<{
        readonly document: Schema.StructWithRest<Schema.Struct<{
            readonly authentication: Schema.$Array<Schema.String>;
            readonly id: Schema.brand<Schema.String, "Lexicon:did">;
            readonly keyAgreement: Schema.$Array<Schema.String>;
            readonly verificationMethod: Schema.$Array<Schema.StructWithRest<Schema.Struct<{
                readonly controller: Schema.String;
                readonly id: Schema.String;
                readonly publicKeyJwk: Schema.StructWithRest<Schema.Struct<{
                    readonly crv: Schema.compose<Schema.Literal<"P-256">, Schema.String>;
                    readonly kty: Schema.compose<Schema.Literal<"EC">, Schema.String>;
                    readonly x: Schema.String;
                    readonly y: Schema.String;
                }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
        readonly name: Schema.String;
        readonly parent: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
            readonly name: Schema.String;
            readonly session: Schema.String;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly inputEncoding: "application/json";
    readonly method: "POST";
    readonly nsid: "sh.mschf.ratking.identity.register";
    readonly output: Schema.StructWithRest<Schema.Struct<{
        readonly did: Schema.brand<Schema.String, "Lexicon:did">;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly outputEncoding: "application/json";
    readonly params: Schema.Undefined;
    readonly path: "/xrpc/sh.mschf.ratking.identity.register";
};
