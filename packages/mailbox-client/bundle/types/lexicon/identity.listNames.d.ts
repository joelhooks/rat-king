import { Effect, Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const Parent: Schema.StructWithRest<Schema.Struct<{
    readonly name: Schema.String;
    readonly session: Schema.String;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ParentValue = typeof Parent.Type;
export declare const Entry: Schema.StructWithRest<Schema.Struct<{
    readonly did: Schema.brand<Schema.String, "Lexicon:did">;
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
    readonly roleTarget: Schema.optionalKey<Schema.Boolean>;
    readonly status: Schema.optionalKey<Schema.compose<Schema.Literals<readonly ["live", "idle", "retired"]>, Schema.String>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type EntryValue = typeof Entry.Type;
export declare const Params: Schema.StructWithRest<Schema.Struct<{
    readonly all: Schema.optionalKey<Schema.Boolean>;
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.optionalKey<Schema.Int>;
    readonly match: Schema.optionalKey<Schema.String>;
    readonly status: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ParamsValue = typeof Params.Type;
export declare const Input: Schema.Undefined;
export type InputValue = typeof Input.Type;
export declare const Output: Schema.StructWithRest<Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly names: Schema.$Array<Schema.StructWithRest<Schema.Struct<{
        readonly did: Schema.brand<Schema.String, "Lexicon:did">;
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
        readonly roleTarget: Schema.optionalKey<Schema.Boolean>;
        readonly status: Schema.optionalKey<Schema.compose<Schema.Literals<readonly ["live", "idle", "retired"]>, Schema.String>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
    readonly scanned: Schema.optionalKey<Schema.Int>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type OutputValue = typeof Output.Type;
export declare const ParamsFromQuery: Schema.compose<Schema.StructWithRest<Schema.Struct<{
    readonly all: Schema.optionalKey<Schema.Boolean>;
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.optionalKey<Schema.Int>;
    readonly match: Schema.optionalKey<Schema.String>;
    readonly status: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
    readonly all: Schema.optionalKey<Schema.decodeTo<Schema.Boolean, Schema.Literals<readonly ["true", "false"]>, never, never>>;
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.optionalKey<Schema.FiniteFromString>;
    readonly match: Schema.optionalKey<Schema.String>;
    readonly status: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
export declare const encodeParams: (params: {
    readonly [x: string]: Runtime.LexValue;
    readonly all?: boolean;
    readonly cursor?: string;
    readonly limit?: number;
    readonly match?: string;
    readonly status?: string;
}) => Effect.Effect<readonly (readonly [string, string])[], Schema.SchemaError, never>;
export declare const decodeParams: (entries: readonly (readonly [string, string])[]) => Effect.Effect<{
    readonly [x: string]: Runtime.LexValue;
    readonly all?: boolean;
    readonly cursor?: string;
    readonly limit?: number;
    readonly match?: string;
    readonly status?: string;
}, Schema.SchemaError, never>;
export declare const ErrorBody: Schema.StructWithRest<Schema.Struct<{
    readonly error: Schema.String;
    readonly message: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ErrorBodyValue = typeof ErrorBody.Type;
export declare const KnownErrors: readonly ["InvalidRequest", "AuthRequired", "MailboxUnavailable"];
export type KnownError = (typeof KnownErrors)[number];
export declare const isKnownError: (value: string) => value is KnownError;
export declare const Method: {
    readonly defaults: {
        readonly limit: 100;
    };
    readonly error: Schema.StructWithRest<Schema.Struct<{
        readonly error: Schema.String;
        readonly message: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly input: Schema.Undefined;
    readonly inputEncoding: "";
    readonly method: "GET";
    readonly nsid: "sh.mschf.ratking.identity.listNames";
    readonly output: Schema.StructWithRest<Schema.Struct<{
        readonly cursor: Schema.optionalKey<Schema.String>;
        readonly names: Schema.$Array<Schema.StructWithRest<Schema.Struct<{
            readonly did: Schema.brand<Schema.String, "Lexicon:did">;
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
            readonly roleTarget: Schema.optionalKey<Schema.Boolean>;
            readonly status: Schema.optionalKey<Schema.compose<Schema.Literals<readonly ["live", "idle", "retired"]>, Schema.String>>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
        readonly scanned: Schema.optionalKey<Schema.Int>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly outputEncoding: "application/json";
    readonly params: Schema.StructWithRest<Schema.Struct<{
        readonly all: Schema.optionalKey<Schema.Boolean>;
        readonly cursor: Schema.optionalKey<Schema.String>;
        readonly limit: Schema.optionalKey<Schema.Int>;
        readonly match: Schema.optionalKey<Schema.String>;
        readonly status: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly path: "/xrpc/sh.mschf.ratking.identity.listNames";
};
