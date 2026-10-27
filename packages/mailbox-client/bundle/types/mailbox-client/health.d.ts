import { Effect, Schema } from "effect";
import { MailboxClientError } from "./error.js";
export declare const WAKE_UNACKED_MS = 180000;
export declare const Wake: Schema.Struct<{
    readonly at: Schema.Finite;
    readonly id: Schema.String;
    readonly sender: Schema.String;
}>;
export declare const MailboxHealth: Schema.Struct<{
    readonly complete: Schema.Boolean;
    readonly lastAck: Schema.NullOr<Schema.Finite>;
    readonly lease: Schema.NullOr<Schema.Struct<{
        readonly expiresAt: Schema.Finite;
        readonly generation: Schema.Int;
        readonly holder: Schema.String;
        readonly pane: Schema.NullOr<Schema.String>;
    }>>;
    readonly oldestWake: Schema.NullOr<Schema.Struct<{
        readonly at: Schema.Finite;
        readonly id: Schema.String;
        readonly sender: Schema.String;
    }>>;
    readonly oldestWakeSinceAck: Schema.optionalKey<Schema.NullOr<Schema.Struct<{
        readonly at: Schema.Finite;
        readonly id: Schema.String;
        readonly sender: Schema.String;
    }>>>;
    readonly quietUnacked: Schema.Int;
}>;
export type MailboxHealthValue = typeof MailboxHealth.Type;
export interface HealthFacts extends MailboxHealthValue {
    readonly unavailable?: string;
    readonly reader: "running" | "stuck" | "unknown";
}
export declare const healthVerdict: (facts: HealthFacts, now: number) => string;
export declare const readMailboxHealth: (transport: {
    readonly request: (request: import("../lexicon/transport.js").Request) => Effect.Effect<import("../lexicon/transport.js").Response, import("../lexicon/transport-failure.js").TransportFailure>;
}, did: string, name: string) => Effect.Effect<{
    readonly complete: boolean;
    readonly lastAck: number | null;
    readonly lease: {
        readonly expiresAt: number;
        readonly generation: number;
        readonly holder: string;
        readonly pane: string | null;
    } | null;
    readonly oldestWake: {
        readonly at: number;
        readonly id: string;
        readonly sender: string;
    } | null;
    readonly oldestWakeSinceAck?: {
        readonly at: number;
        readonly id: string;
        readonly sender: string;
    } | null;
    readonly quietUnacked: number;
}, MailboxClientError, never>;
