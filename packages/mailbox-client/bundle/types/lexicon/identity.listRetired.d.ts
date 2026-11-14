import { Effect, Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const Params: Schema.StructWithRest<Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.optionalKey<Schema.Int>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ParamsValue = typeof Params.Type;
export declare const Input: Schema.Undefined;
export type InputValue = typeof Input.Type;
export declare const Output: Schema.StructWithRest<Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly retired: Schema.$Array<Schema.StructWithRest<Schema.Struct<{
        readonly by: Schema.brand<Schema.String, "Lexicon:did">;
        readonly did: Schema.brand<Schema.String, "Lexicon:did">;
        readonly name: Schema.String;
        readonly retiredAt: Schema.brand<Schema.String, "Lexicon:datetime">;
        readonly successor: Schema.optionalKey<Schema.String>;
        readonly updatedAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type OutputValue = typeof Output.Type;
export declare const ParamsFromQuery: Schema.compose<Schema.StructWithRest<Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.optionalKey<Schema.Int>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.optionalKey<Schema.FiniteFromString>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
export declare const encodeParams: (params: {
    readonly [x: string]: Runtime.LexValue;
    readonly cursor?: string;
    readonly limit?: number;
}) => Effect.Effect<readonly (readonly [string, string])[], Schema.SchemaError, never>;
export declare const decodeParams: (entries: readonly (readonly [string, string])[]) => Effect.Effect<{
    readonly [x: string]: Runtime.LexValue;
    readonly cursor?: string;
    readonly limit?: number;
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
    readonly nsid: "sh.mschf.ratking.identity.listRetired";
    readonly output: Schema.StructWithRest<Schema.Struct<{
        readonly cursor: Schema.optionalKey<Schema.String>;
        readonly retired: Schema.$Array<Schema.StructWithRest<Schema.Struct<{
            readonly by: Schema.brand<Schema.String, "Lexicon:did">;
            readonly did: Schema.brand<Schema.String, "Lexicon:did">;
            readonly name: Schema.String;
            readonly retiredAt: Schema.brand<Schema.String, "Lexicon:datetime">;
            readonly successor: Schema.optionalKey<Schema.String>;
            readonly updatedAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly outputEncoding: "application/json";
    readonly params: Schema.StructWithRest<Schema.Struct<{
        readonly cursor: Schema.optionalKey<Schema.String>;
        readonly limit: Schema.optionalKey<Schema.Int>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly path: "/xrpc/sh.mschf.ratking.identity.listRetired";
};
