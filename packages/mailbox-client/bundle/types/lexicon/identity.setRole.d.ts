import { Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const Role: Schema.StructWithRest<Schema.Struct<{
    readonly name: Schema.String;
    readonly role: Schema.String;
    readonly target: Schema.String;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type RoleValue = typeof Role.Type;
export declare const Params: Schema.Undefined;
export type ParamsValue = typeof Params.Type;
export declare const Input: Schema.StructWithRest<Schema.Struct<{
    readonly name: Schema.String;
    readonly role: Schema.String;
    readonly target: Schema.String;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type InputValue = typeof Input.Type;
export declare const Output: Schema.StructWithRest<Schema.Struct<{
    readonly name: Schema.String;
    readonly role: Schema.String;
    readonly target: Schema.String;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type OutputValue = typeof Output.Type;
export declare const ErrorBody: Schema.StructWithRest<Schema.Struct<{
    readonly error: Schema.String;
    readonly message: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ErrorBodyValue = typeof ErrorBody.Type;
export declare const KnownErrors: readonly ["InvalidRequest", "InvalidName", "AuthRequired", "Forbidden", "NameCollision", "UnknownName", "MailboxUnavailable"];
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
        readonly role: Schema.String;
        readonly target: Schema.String;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly inputEncoding: "application/json";
    readonly method: "POST";
    readonly nsid: "sh.mschf.ratking.identity.setRole";
    readonly output: Schema.StructWithRest<Schema.Struct<{
        readonly name: Schema.String;
        readonly role: Schema.String;
        readonly target: Schema.String;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly outputEncoding: "application/json";
    readonly params: Schema.Undefined;
    readonly path: "/xrpc/sh.mschf.ratking.identity.setRole";
};
