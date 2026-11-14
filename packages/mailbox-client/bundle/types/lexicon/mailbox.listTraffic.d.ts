import { Effect, Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const CriticalCount: Schema.StructWithRest<Schema.Struct<{
    readonly count: Schema.Int;
    readonly day: Schema.String;
    readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type CriticalCountValue = typeof CriticalCount.Type;
export declare const Via: Schema.StructWithRest<Schema.Struct<{
    readonly desk: Schema.String;
    readonly deskDid: Schema.brand<Schema.String, "Lexicon:did">;
    readonly run: Schema.String;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ViaValue = typeof Via.Type;
export declare const Entry: Schema.StructWithRest<Schema.Struct<{
    readonly body: Schema.optionalKey<Schema.String>;
    readonly ciphertextSize: Schema.Int;
    readonly messageId: Schema.brand<Schema.String, "Lexicon:tid">;
    readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
    readonly recipientSeq: Schema.Int;
    readonly resolvedFrom: Schema.optionalKey<Schema.String>;
    readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
    readonly seq: Schema.Int;
    readonly state: Schema.String;
    readonly time: Schema.brand<Schema.String, "Lexicon:datetime">;
    readonly via: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
        readonly desk: Schema.String;
        readonly deskDid: Schema.brand<Schema.String, "Lexicon:did">;
        readonly run: Schema.String;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type EntryValue = typeof Entry.Type;
export declare const Params: Schema.StructWithRest<Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.optionalKey<Schema.Int>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ParamsValue = typeof Params.Type;
export declare const Input: Schema.Undefined;
export type InputValue = typeof Input.Type;
export declare const Output: Schema.StructWithRest<Schema.Struct<{
    readonly criticalCounts: Schema.optionalKey<Schema.$Array<Schema.StructWithRest<Schema.Struct<{
        readonly count: Schema.Int;
        readonly day: Schema.String;
        readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>>;
    readonly cursor: Schema.String;
    readonly events: Schema.$Array<Schema.StructWithRest<Schema.Struct<{
        readonly body: Schema.optionalKey<Schema.String>;
        readonly ciphertextSize: Schema.Int;
        readonly messageId: Schema.brand<Schema.String, "Lexicon:tid">;
        readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
        readonly recipientSeq: Schema.Int;
        readonly resolvedFrom: Schema.optionalKey<Schema.String>;
        readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
        readonly seq: Schema.Int;
        readonly state: Schema.String;
        readonly time: Schema.brand<Schema.String, "Lexicon:datetime">;
        readonly via: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
            readonly desk: Schema.String;
            readonly deskDid: Schema.brand<Schema.String, "Lexicon:did">;
            readonly run: Schema.String;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
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
export declare const KnownErrors: readonly ["AuthRequired", "Forbidden", "InvalidCursor", "MailboxUnavailable"];
export type KnownError = (typeof KnownErrors)[number];
export declare const isKnownError: (value: string) => value is KnownError;
export declare const Method: {
    readonly defaults: {
        readonly limit: 50;
    };
    readonly error: Schema.StructWithRest<Schema.Struct<{
        readonly error: Schema.String;
        readonly message: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly input: Schema.Undefined;
    readonly inputEncoding: "";
    readonly method: "GET";
    readonly nsid: "sh.mschf.ratking.mailbox.listTraffic";
    readonly output: Schema.StructWithRest<Schema.Struct<{
        readonly criticalCounts: Schema.optionalKey<Schema.$Array<Schema.StructWithRest<Schema.Struct<{
            readonly count: Schema.Int;
            readonly day: Schema.String;
            readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>>;
        readonly cursor: Schema.String;
        readonly events: Schema.$Array<Schema.StructWithRest<Schema.Struct<{
            readonly body: Schema.optionalKey<Schema.String>;
            readonly ciphertextSize: Schema.Int;
            readonly messageId: Schema.brand<Schema.String, "Lexicon:tid">;
            readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
            readonly recipientSeq: Schema.Int;
            readonly resolvedFrom: Schema.optionalKey<Schema.String>;
            readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
            readonly seq: Schema.Int;
            readonly state: Schema.String;
            readonly time: Schema.brand<Schema.String, "Lexicon:datetime">;
            readonly via: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
                readonly desk: Schema.String;
                readonly deskDid: Schema.brand<Schema.String, "Lexicon:did">;
                readonly run: Schema.String;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly outputEncoding: "application/json";
    readonly params: Schema.StructWithRest<Schema.Struct<{
        readonly cursor: Schema.optionalKey<Schema.String>;
        readonly limit: Schema.optionalKey<Schema.Int>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly path: "/xrpc/sh.mschf.ratking.mailbox.listTraffic";
};
