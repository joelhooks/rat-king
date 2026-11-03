import { Schema } from "effect";
declare const MailboxClientError_base: Schema.Class<MailboxClientError, Schema.TaggedStruct<"MailboxClientError", {
    readonly error: Schema.optionalKey<Schema.String>;
    readonly reason: Schema.String;
    readonly status: Schema.optionalKey<Schema.Finite>;
}>, import("effect/Cause").YieldableError>;
export declare class MailboxClientError extends MailboxClientError_base {
}
export declare const connectionFailure: (failure: {
    readonly _tag: string;
}) => boolean;
export declare const clientError: (failure: {
    readonly _tag: string;
}) => MailboxClientError;
export {};
