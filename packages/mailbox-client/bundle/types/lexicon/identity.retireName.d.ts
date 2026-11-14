import { Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const Retirement: Schema.StructWithRest<Schema.Struct<{
    readonly by: Schema.brand<Schema.String, "Lexicon:did">;
    readonly did: Schema.brand<Schema.String, "Lexicon:did">;
    readonly name: Schema.String;
    readonly retiredAt: Schema.brand<Schema.String, "Lexicon:datetime">;
    readonly successor: Schema.optionalKey<Schema.String>;
    readonly updatedAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type RetirementValue = typeof Retirement.Type;
export declare const Params: Schema.Undefined;
export type ParamsValue = typeof Params.Type;
export declare const Input: Schema.StructWithRest<Schema.Struct<{
    readonly name: Schema.String;
    readonly successor: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type InputValue = typeof Input.Type;
export declare const Output: Schema.StructWithRest<Schema.Struct<{
    readonly by: Schema.brand<Schema.String, "Lexicon:did">;
    readonly did: Schema.brand<Schema.String, "Lexicon:did">;
    readonly name: Schema.String;
    readonly retiredAt: Schema.brand<Schema.String, "Lexicon:datetime">;
    readonly successor: Schema.optionalKey<Schema.String>;
    readonly updatedAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type OutputValue = typeof Output.Type;
export declare const ErrorBody: Schema.StructWithRest<Schema.Struct<{
    readonly error: Schema.String;
    readonly message: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ErrorBodyValue = typeof ErrorBody.Type;
export declare const KnownErrors: readonly ["InvalidRequest", "InvalidName", "AuthRequired", "Forbidden", "NameReserved", "NameNotFound", "LeaseLive", "MailboxUnavailable"];
export type KnownError = (typeof KnownErrors)[number];
export declare const isKnownError: (value: string) => value is KnownError;
export declare const Method: {
    readonly defaults: {};
    readonly error: Schema.StructWithRest<Schema.Struct<{
        readonly error: Schema.String;
        readonly message: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly input: Schema.StructWithRest<Schema.Struct<{
        readonly name: Schema.String;
        readonly successor: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly inputEncoding: "application/json";
    readonly method: "POST";
    readonly nsid: "sh.mschf.ratking.identity.retireName";
    readonly output: Schema.StructWithRest<Schema.Struct<{
        readonly by: Schema.brand<Schema.String, "Lexicon:did">;
        readonly did: Schema.brand<Schema.String, "Lexicon:did">;
        readonly name: Schema.String;
        readonly retiredAt: Schema.brand<Schema.String, "Lexicon:datetime">;
        readonly successor: Schema.optionalKey<Schema.String>;
        readonly updatedAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly outputEncoding: "application/json";
    readonly params: Schema.Undefined;
    readonly path: "/xrpc/sh.mschf.ratking.identity.retireName";
};
