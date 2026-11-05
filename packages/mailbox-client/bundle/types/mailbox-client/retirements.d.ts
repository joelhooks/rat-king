import { Effect } from "effect";
import { MailboxClientError } from "./error.js";
export declare const readRetirements: (transport: {
    readonly request: (request: import("../lexicon/transport.js").Request) => Effect.Effect<import("../lexicon/transport.js").Response, import("../lexicon/transport-failure.js").TransportFailure>;
}) => Effect.Effect<string[], MailboxClientError, never>;
