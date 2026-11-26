import * as Prefs from "../lexicon/attention.prefs.js";
import * as Status from "../lexicon/attention.status.js";
import type { MailboxInterface } from "../lexicon/mailbox-client.js";
import { Effect } from "effect";
import type { MailboxClientError } from "./error.js";
import type { RuntimeIdentity } from "./identity.js";
export declare const attentionBytes: (did: string, nsid: string, value: Prefs.MainValue | Status.MainValue) => Uint8Array;
export interface AttentionClient {
    readonly getPreferences: () => Effect.Effect<Prefs.MainValue, MailboxClientError>;
    readonly getStatus: (did?: string) => Effect.Effect<Status.MainValue, MailboxClientError>;
    readonly putPreferences: (prefs: Prefs.MainValue) => Effect.Effect<Prefs.MainValue, MailboxClientError>;
    readonly putStatus: (status: Status.MainValue) => Effect.Effect<Status.MainValue, MailboxClientError>;
}
export declare const attentionClient: (client: MailboxInterface, identity: RuntimeIdentity) => AttentionClient;
export declare const defaultPreferences: () => Prefs.MainValue;
export declare const defaultStatus: () => Status.MainValue;
export declare const toBasisPoints: (decimal: number) => number;
export declare const fromBasisPoints: (points: number) => number;
