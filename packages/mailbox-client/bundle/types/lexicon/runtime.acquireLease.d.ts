import { Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const Params: Schema.Undefined;
export type ParamsValue = typeof Params.Type;
export declare const Input: Schema.StructWithRest<Schema.Struct<{
    readonly attempt: Schema.optionalKey<Schema.String>;
    readonly did: Schema.brand<Schema.String, "Lexicon:did">;
    readonly expiresAt: Schema.brand<Schema.String, "Lexicon:datetime">;
    readonly generation: Schema.optionalKey<Schema.Int>;
    readonly harness: Schema.Union<readonly [Schema.StructWithRest<Schema.Struct<{
        readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#pi">;
        readonly executionId: Schema.optionalKey<Schema.String>;
        readonly paneId: Schema.optionalKey<Schema.String>;
        readonly sessionId: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
        readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#claude">;
        readonly executionId: Schema.optionalKey<Schema.String>;
        readonly paneId: Schema.optionalKey<Schema.String>;
        readonly sessionId: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
        readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#codex">;
        readonly executionId: Schema.optionalKey<Schema.String>;
        readonly paneId: Schema.optionalKey<Schema.String>;
        readonly sessionId: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
        readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#opencode">;
        readonly executionId: Schema.optionalKey<Schema.String>;
        readonly paneId: Schema.optionalKey<Schema.String>;
        readonly sessionId: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
        readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#other">;
        readonly executionId: Schema.optionalKey<Schema.String>;
        readonly kind: Schema.String;
        readonly paneId: Schema.optionalKey<Schema.String>;
        readonly sessionId: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
        readonly $type: Schema.String;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>]>;
    readonly leaseId: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:tid">>;
    readonly renders: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type InputValue = typeof Input.Type;
export declare const Output: Schema.StructWithRest<Schema.Struct<{
    readonly lease: Schema.StructWithRest<Schema.Struct<{
        readonly did: Schema.brand<Schema.String, "Lexicon:did">;
        readonly expiresAt: Schema.brand<Schema.String, "Lexicon:datetime">;
        readonly generation: Schema.Int;
        readonly harness: Schema.Union<readonly [Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#pi">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#claude">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#codex">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#opencode">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#other">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly kind: Schema.String;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.String;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>]>;
        readonly issuedAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
        readonly leaseId: Schema.brand<Schema.String, "Lexicon:tid">;
        readonly renders: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type OutputValue = typeof Output.Type;
export declare const ErrorBody: Schema.StructWithRest<Schema.Struct<{
    readonly error: Schema.String;
    readonly message: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type ErrorBodyValue = typeof ErrorBody.Type;
export declare const KnownErrors: readonly ["InvalidRequest", "AuthRequired", "Forbidden", "LeaseHeld", "AcquireAttemptExpired"];
export type KnownError = (typeof KnownErrors)[number];
export declare const isKnownError: (value: string) => value is KnownError;
export declare const Method: {
    readonly defaults: {};
    readonly error: Schema.StructWithRest<Schema.Struct<{
        readonly error: Schema.String;
        readonly message: Schema.optionalKey<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly input: Schema.StructWithRest<Schema.Struct<{
        readonly attempt: Schema.optionalKey<Schema.String>;
        readonly did: Schema.brand<Schema.String, "Lexicon:did">;
        readonly expiresAt: Schema.brand<Schema.String, "Lexicon:datetime">;
        readonly generation: Schema.optionalKey<Schema.Int>;
        readonly harness: Schema.Union<readonly [Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#pi">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#claude">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#codex">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#opencode">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#other">;
            readonly executionId: Schema.optionalKey<Schema.String>;
            readonly kind: Schema.String;
            readonly paneId: Schema.optionalKey<Schema.String>;
            readonly sessionId: Schema.optionalKey<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
            readonly $type: Schema.String;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>]>;
        readonly leaseId: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:tid">>;
        readonly renders: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly inputEncoding: "application/json";
    readonly method: "POST";
    readonly nsid: "sh.mschf.ratking.runtime.acquireLease";
    readonly output: Schema.StructWithRest<Schema.Struct<{
        readonly lease: Schema.StructWithRest<Schema.Struct<{
            readonly did: Schema.brand<Schema.String, "Lexicon:did">;
            readonly expiresAt: Schema.brand<Schema.String, "Lexicon:datetime">;
            readonly generation: Schema.Int;
            readonly harness: Schema.Union<readonly [Schema.StructWithRest<Schema.Struct<{
                readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#pi">;
                readonly executionId: Schema.optionalKey<Schema.String>;
                readonly paneId: Schema.optionalKey<Schema.String>;
                readonly sessionId: Schema.optionalKey<Schema.String>;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
                readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#claude">;
                readonly executionId: Schema.optionalKey<Schema.String>;
                readonly paneId: Schema.optionalKey<Schema.String>;
                readonly sessionId: Schema.optionalKey<Schema.String>;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
                readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#codex">;
                readonly executionId: Schema.optionalKey<Schema.String>;
                readonly paneId: Schema.optionalKey<Schema.String>;
                readonly sessionId: Schema.optionalKey<Schema.String>;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
                readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#opencode">;
                readonly executionId: Schema.optionalKey<Schema.String>;
                readonly paneId: Schema.optionalKey<Schema.String>;
                readonly sessionId: Schema.optionalKey<Schema.String>;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
                readonly $type: Schema.Literal<"sh.mschf.ratking.runtime.lease#other">;
                readonly executionId: Schema.optionalKey<Schema.String>;
                readonly kind: Schema.String;
                readonly paneId: Schema.optionalKey<Schema.String>;
                readonly sessionId: Schema.optionalKey<Schema.String>;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>, Schema.StructWithRest<Schema.Struct<{
                readonly $type: Schema.String;
            }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>]>;
            readonly issuedAt: Schema.optionalKey<Schema.brand<Schema.String, "Lexicon:datetime">>;
            readonly leaseId: Schema.brand<Schema.String, "Lexicon:tid">;
            readonly renders: Schema.optionalKey<Schema.$Array<Schema.String>>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
    readonly outputEncoding: "application/json";
    readonly params: Schema.Undefined;
    readonly path: "/xrpc/sh.mschf.ratking.runtime.acquireLease";
};
