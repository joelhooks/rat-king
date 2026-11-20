import { Effect } from "effect";
import { MailboxClientError } from "./error.js";
export declare const registerDevice: (transport: {
    readonly request: (request: import("../lexicon/transport.js").Request) => Effect.Effect<import("../lexicon/transport.js").Response, import("../lexicon/transport-failure.js").TransportFailure>;
}, input: {
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly did: string & import("effect/Brand").Brand<"Lexicon:did">;
    readonly environment: "production" | "sandbox";
    readonly token: string;
}) => Effect.Effect<{
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly registered: true;
}, MailboxClientError, never>;
export declare const readPendingPush: (transport: {
    readonly request: (request: import("../lexicon/transport.js").Request) => Effect.Effect<import("../lexicon/transport.js").Response, import("../lexicon/transport-failure.js").TransportFailure>;
}, recipientDid: string) => Effect.Effect<{
    readonly [x: string]: import("../lexicon/runtime.js").LexValue;
    readonly notice?: {
        readonly [x: string]: import("../lexicon/runtime.js").LexValue;
        readonly admissionSeq: number;
        readonly body: string;
        readonly environment: "production" | "sandbox";
        readonly messageId: string & import("effect/Brand").Brand<"Lexicon:tid">;
        readonly title: string;
        readonly token: string;
    };
}, MailboxClientError, never>;
