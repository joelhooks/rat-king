import { Effect, Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const Lease: Schema.StructWithRest<Schema.Struct<{
    readonly expiresAt: Schema.brand<Schema.String, "Lexicon:datetime">;
    readonly generation: Schema.Int;
    readonly holder: Schema.String;
    readonly pane: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type LeaseValue = typeof Lease.Type;
export declare const Wake: Schema.StructWithRest<Schema.Struct<{
    readonly id: Schema.brand<Schema.String, "Lexicon:tid">;
    readonly recordedAt: Schema.brand<Schema.String, "Lexicon:datetime">;
    readonly sender: Schema.brand<Schema.String, "Lexicon:did">;
    readonly woke: Schema.Boolean;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type WakeValue = typeof Wake.Type;
export declare const Params: Schema.StructWithRest<Schema.Struct<{
    readonly name: Schema.String;
    readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ParamsValue = typeof Params.Type;
export declare const Input: Schema.Undefined;
export type InputValue = typeof Input.Type;
export declare const Output: Schema.StructWithRest<Schema.Struct<{
    readonly complete: Schema.Boolean;
    readonly lastAck: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
    readonly lease: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
        readonly expiresAt: Schema.brand<Schema.String, "Lexicon:datetime">;
        readonly generation: Schema.Int;
        readonly holder: Schema.String;
        readonly pane: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
    readonly oldestWake: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
        readonly id: Schema.brand<Schema.String, "Lexicon:tid">;
        readonly recordedAt: Schema.brand<Schema.String, "Lexicon:datetime">;
        readonly sender: Schema.brand<Schema.String, "Lexicon:did">;
        readonly woke: Schema.Boolean;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
    readonly oldestWakeSinceAck: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
        readonly id: Schema.brand<Schema.String, "Lexicon:tid">;
        readonly recordedAt: Schema.brand<Schema.String, "Lexicon:datetime">;
        readonly sender: Schema.brand<Schema.String, "Lexicon:did">;
        readonly woke: Schema.Boolean;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
    readonly quietUnacked: Schema.Int;
    readonly wakesSinceAck: Schema.optionalKey<Schema.Int>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type OutputValue = typeof Output.Type;
export declare const ParamsFromQuery: Schema.compose<Schema.StructWithRest<Schema.Struct<{
    readonly name: Schema.String;
    readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
    readonly name: Schema.String;
    readonly recipientDid: Schema.String;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
export declare const encodeParams: (params: {
    readonly [x: string]: Runtime.LexValue;
    readonly name: string;
    readonly recipientDid: string & import("effect/Brand").Brand<"Lexicon:did">;
}) => Effect.Effect<readonly (readonly [string, string])[], Schema.SchemaError, never>;
export declare const decodeParams: (entries: readonly (readonly [string, string])[]) => Effect.Effect<{
    readonly [x: string]: Runtime.LexValue;
    readonly name: string;
    readonly recipientDid: string & import("effect/Brand").Brand<"Lexicon:did">;
}, Schema.SchemaError, never>;
export declare const ErrorBody: Schema.StructWithRest<Schema.Struct<{
    readonly error: Schema.String;
    readonly message: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ErrorBodyValue = typeof ErrorBody.Type;
export declare const KnownErrors: readonly ["AuthRequired", "Forbidden", "MailboxUnavailable"];
export type KnownError = (typeof KnownErrors)[number];
export declare const isKnownError: (value: string) => value is KnownError;
export declare const Method: {
    readonly defaults: {};
    readonly error: Schema.StructWithRest<Schema.Struct<{
        readonly error: Schema.String;
        readonly message: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly input: Schema.Undefined;
    readonly inputEncoding: "";
    readonly method: "GET";
    readonly nsid: "sh.mschf.ratking.mailbox.nameHealth";
    readonly output: Schema.StructWithRest<Schema.Struct<{
        readonly complete: Schema.Boolean;
        readonly lastAck: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
        readonly lease: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
            readonly expiresAt: Schema.brand<Schema.String, "Lexicon:datetime">;
            readonly generation: Schema.Int;
            readonly holder: Schema.String;
            readonly pane: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
        readonly oldestWake: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
            readonly id: Schema.brand<Schema.String, "Lexicon:tid">;
            readonly recordedAt: Schema.brand<Schema.String, "Lexicon:datetime">;
            readonly sender: Schema.brand<Schema.String, "Lexicon:did">;
            readonly woke: Schema.Boolean;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
        readonly oldestWakeSinceAck: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
            readonly id: Schema.brand<Schema.String, "Lexicon:tid">;
            readonly recordedAt: Schema.brand<Schema.String, "Lexicon:datetime">;
            readonly sender: Schema.brand<Schema.String, "Lexicon:did">;
            readonly woke: Schema.Boolean;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
        readonly quietUnacked: Schema.Int;
        readonly wakesSinceAck: Schema.optionalKey<Schema.Int>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly outputEncoding: "application/json";
    readonly params: Schema.StructWithRest<Schema.Struct<{
        readonly name: Schema.String;
        readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly path: "/xrpc/sh.mschf.ratking.mailbox.nameHealth";
};
