import { Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const Params: Schema.Undefined;
export type ParamsValue = typeof Params.Type;
export declare const Input: Schema.StructWithRest<Schema.Struct<{
    readonly critical: Schema.optionalKey<Schema.Boolean>;
    readonly envelope: Schema.StructWithRest<Schema.Struct<{
        readonly aad: Schema.StructWithRest<Schema.Struct<{
            readonly expiresAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
            readonly messageId: Schema.brand<Schema.String, "Lexicon:tid">;
            readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
            readonly recipientKeyId: Schema.brand<Schema.String, "Lexicon:uri">;
            readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
        readonly ciphertext: Schema.decodeTo<Schema.Uint8Array, Schema.compose<Schema.Struct<{
            readonly $bytes: Schema.Uint8ArrayFromBase64;
        }>, Schema.StructWithRest<Schema.Struct<{
            readonly $bytes: Schema.String;
        }>, readonly [Schema.$Record<Schema.String, Schema.String>]>>, never, never>;
        readonly enc: Schema.decodeTo<Schema.Uint8Array, Schema.compose<Schema.Struct<{
            readonly $bytes: Schema.Uint8ArrayFromBase64;
        }>, Schema.StructWithRest<Schema.Struct<{
            readonly $bytes: Schema.String;
        }>, readonly [Schema.$Record<Schema.String, Schema.String>]>>, never, never>;
        readonly suite: Schema.StructWithRest<Schema.Struct<{
            readonly aeadId: Schema.Int;
            readonly kdfId: Schema.Int;
            readonly kemId: Schema.Int;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
        readonly version: Schema.Int;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly generation: Schema.optionalKey<Schema.Int>;
    readonly leaseId: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:tid">>;
    readonly resolvedFrom: Schema.optionalKey<Schema.String>;
    readonly wakeReason: Schema.optionalKey<Schema.compose<Schema.Literals<readonly ["to", "ask", "reply", "cc", "quiet", "data"]>, Schema.String>>;
    readonly woke: Schema.optionalKey<Schema.Boolean>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type InputValue = typeof Input.Type;
export declare const Output: Schema.StructWithRest<Schema.Struct<{
    readonly receipt: Schema.StructWithRest<Schema.Struct<{
        readonly delegated: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
            readonly to: Schema.String;
            readonly until: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
        readonly delegatedFor: Schema.optionalKey<Schema.String>;
        readonly delegatedTo: Schema.optionalKey<Schema.String>;
        readonly detail: Schema.optionalKey<Schema.String>;
        readonly message: Schema.StructWithRest<Schema.Struct<{
            readonly cid: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:cid">>;
            readonly messageId: Schema.brand<Schema.String, "Lexicon:tid">;
            readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
            readonly uri: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:at-uri">>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
        readonly originalId: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:tid">>;
        readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
        readonly recordedAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
        readonly resolvedFrom: Schema.optionalKey<Schema.String>;
        readonly seq: Schema.Int;
        readonly state: Schema.String;
        readonly via: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
            readonly desk: Schema.String;
            readonly deskDid: Schema.brand<Schema.String, "Lexicon:did">;
            readonly pass: Schema.StructWithRest<Schema.Struct<{
                readonly record: Schema.StructWithRest<Schema.Struct<{
                    readonly $type: Schema.Literal<"sh.ratking.pass">;
                    readonly desk: Schema.String;
                    readonly deskDid: Schema.brand<Schema.String, "Lexicon:did">;
                    readonly exp: Schema.Int;
                    readonly iat: Schema.Int;
                    readonly nonce: Schema.String;
                    readonly run: Schema.String;
                    readonly scope: Schema.$Array<Schema.String>;
                    readonly v: Schema.Literal<1>;
                    readonly worker: Schema.brand<Schema.String, "Lexicon:did">;
                }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
                readonly signature: Schema.String;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
            readonly run: Schema.String;
            readonly worker: Schema.brand<Schema.String, "Lexicon:did">;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
        readonly wakeReason: Schema.optionalKey<Schema.String>;
        readonly woke: Schema.optionalKey<Schema.Boolean>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type OutputValue = typeof Output.Type;
export declare const ErrorBody: Schema.StructWithRest<Schema.Struct<{
    readonly error: Schema.String;
    readonly message: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ErrorBodyValue = typeof ErrorBody.Type;
export declare const KnownErrors: readonly ["LeaseMismatch", "Retired", "RoleUnresolved", "InvalidRequest", "AuthRequired", "Forbidden", "Conflict", "UnsupportedEnvelope", "MailboxUnavailable"];
export type KnownError = (typeof KnownErrors)[number];
export declare const isKnownError: (value: string) => value is KnownError;
export declare const Method: {
    readonly defaults: {};
    readonly error: Schema.StructWithRest<Schema.Struct<{
        readonly error: Schema.String;
        readonly message: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly input: Schema.StructWithRest<Schema.Struct<{
        readonly critical: Schema.optionalKey<Schema.Boolean>;
        readonly envelope: Schema.StructWithRest<Schema.Struct<{
            readonly aad: Schema.StructWithRest<Schema.Struct<{
                readonly expiresAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
                readonly messageId: Schema.brand<Schema.String, "Lexicon:tid">;
                readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
                readonly recipientKeyId: Schema.brand<Schema.String, "Lexicon:uri">;
                readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
            readonly ciphertext: Schema.decodeTo<Schema.Uint8Array, Schema.compose<Schema.Struct<{
                readonly $bytes: Schema.Uint8ArrayFromBase64;
            }>, Schema.StructWithRest<Schema.Struct<{
                readonly $bytes: Schema.String;
            }>, readonly [Schema.$Record<Schema.String, Schema.String>]>>, never, never>;
            readonly enc: Schema.decodeTo<Schema.Uint8Array, Schema.compose<Schema.Struct<{
                readonly $bytes: Schema.Uint8ArrayFromBase64;
            }>, Schema.StructWithRest<Schema.Struct<{
                readonly $bytes: Schema.String;
            }>, readonly [Schema.$Record<Schema.String, Schema.String>]>>, never, never>;
            readonly suite: Schema.StructWithRest<Schema.Struct<{
                readonly aeadId: Schema.Int;
                readonly kdfId: Schema.Int;
                readonly kemId: Schema.Int;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
            readonly version: Schema.Int;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
        readonly generation: Schema.optionalKey<Schema.Int>;
        readonly leaseId: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:tid">>;
        readonly resolvedFrom: Schema.optionalKey<Schema.String>;
        readonly wakeReason: Schema.optionalKey<Schema.compose<Schema.Literals<readonly ["to", "ask", "reply", "cc", "quiet", "data"]>, Schema.String>>;
        readonly woke: Schema.optionalKey<Schema.Boolean>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly inputEncoding: "application/json";
    readonly method: "POST";
    readonly nsid: "sh.mschf.ratking.mailbox.send";
    readonly output: Schema.StructWithRest<Schema.Struct<{
        readonly receipt: Schema.StructWithRest<Schema.Struct<{
            readonly delegated: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
                readonly to: Schema.String;
                readonly until: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
            readonly delegatedFor: Schema.optionalKey<Schema.String>;
            readonly delegatedTo: Schema.optionalKey<Schema.String>;
            readonly detail: Schema.optionalKey<Schema.String>;
            readonly message: Schema.StructWithRest<Schema.Struct<{
                readonly cid: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:cid">>;
                readonly messageId: Schema.brand<Schema.String, "Lexicon:tid">;
                readonly senderDid: Schema.brand<Schema.String, "Lexicon:did">;
                readonly uri: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:at-uri">>;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
            readonly originalId: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:tid">>;
            readonly recipientDid: Schema.brand<Schema.String, "Lexicon:did">;
            readonly recordedAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
            readonly resolvedFrom: Schema.optionalKey<Schema.String>;
            readonly seq: Schema.Int;
            readonly state: Schema.String;
            readonly via: Schema.optionalKey<Schema.StructWithRest<Schema.Struct<{
                readonly desk: Schema.String;
                readonly deskDid: Schema.brand<Schema.String, "Lexicon:did">;
                readonly pass: Schema.StructWithRest<Schema.Struct<{
                    readonly record: Schema.StructWithRest<Schema.Struct<{
                        readonly $type: Schema.Literal<"sh.ratking.pass">;
                        readonly desk: Schema.String;
                        readonly deskDid: Schema.brand<Schema.String, "Lexicon:did">;
                        readonly exp: Schema.Int;
                        readonly iat: Schema.Int;
                        readonly nonce: Schema.String;
                        readonly run: Schema.String;
                        readonly scope: Schema.$Array<Schema.String>;
                        readonly v: Schema.Literal<1>;
                        readonly worker: Schema.brand<Schema.String, "Lexicon:did">;
                    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
                    readonly signature: Schema.String;
                }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
                readonly run: Schema.String;
                readonly worker: Schema.brand<Schema.String, "Lexicon:did">;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>>;
            readonly wakeReason: Schema.optionalKey<Schema.String>;
            readonly woke: Schema.optionalKey<Schema.Boolean>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly outputEncoding: "application/json";
    readonly params: Schema.Undefined;
    readonly path: "/xrpc/sh.mschf.ratking.mailbox.send";
};
