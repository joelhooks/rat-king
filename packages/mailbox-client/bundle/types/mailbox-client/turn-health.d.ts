import { Effect } from "effect";
import { MailboxClientError } from "./error.js";
export declare const readTurnHealth: (transport: {
    readonly request: (request: import("../lexicon/transport.js").Request) => Effect.Effect<import("../lexicon/transport.js").Response, import("../lexicon/transport-failure.js").TransportFailure>;
}, did: string, name: string, session: string, startsOnly?: boolean | undefined) => Effect.Effect<{
    readonly at: string;
    readonly state: string;
    readonly turnId: string;
} | null, MailboxClientError, never>;
