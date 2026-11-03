import * as AttentionReceipt from "../lexicon/attention.receipt.js";
import * as Defs from "../lexicon/defs.js";
import type * as Lease from "../lexicon/runtime.lease.js";
import { Effect, Option } from "effect";
import { MailboxClientError } from "./error.js";
import type { LeaseFence, OpenedMessage, RatKingMailbox } from "./mailbox.js";
import type { RetryObserver } from "./retry-metrics.js";
export declare const consumerMachine: import("xstate").StateMachine<{}, {
    type: string;
}, {
    [x: string]: import("xstate").AnyActor;
}, "acquiring" | "closed" | "consuming" | "releasing" | "retrying" | "waiting", string, unknown, undefined, {
    type: string;
}, never, {
    readonly context: {};
    readonly id: "mailbox-consumer";
    readonly initial: "acquiring";
    readonly states: {
        readonly acquiring: {
            readonly on: {
                readonly ACQUIRED: {
                    readonly target: "consuming";
                };
                readonly HELD: {
                    readonly target: "waiting";
                };
                readonly REFUSED: {
                    readonly target: "closed";
                };
            };
        };
        readonly closed: {
            readonly type: "final";
        };
        readonly consuming: {
            readonly on: {
                readonly LOST: {
                    readonly target: "releasing";
                };
                readonly RETRYING: {
                    readonly target: "retrying";
                };
                readonly STOP: {
                    readonly target: "releasing";
                };
            };
        };
        readonly releasing: {
            readonly on: {
                readonly RELEASED: {
                    readonly target: "closed";
                };
            };
        };
        readonly retrying: {
            readonly on: {
                readonly ACQUIRED: {
                    readonly target: "consuming";
                };
                readonly LOST: {
                    readonly target: "releasing";
                };
                readonly STOP: {
                    readonly target: "releasing";
                };
            };
        };
        readonly waiting: {
            readonly on: {
                readonly RETRY: {
                    readonly target: "acquiring";
                };
            };
        };
    };
}, Record<string, (...args: any[]) => void | {
    context?: any;
    children?: any;
}>, Record<string, import("xstate").AnyActorLogic>, Record<string, Function>, Record<string, number | Function>, never, never> & {
    states: {
        readonly context: {};
        readonly id: "mailbox-consumer";
        readonly initial: "acquiring";
        readonly states: {
            readonly acquiring: {
                readonly on: {
                    readonly ACQUIRED: {
                        readonly target: "consuming";
                    };
                    readonly HELD: {
                        readonly target: "waiting";
                    };
                    readonly REFUSED: {
                        readonly target: "closed";
                    };
                };
            };
            readonly closed: {
                readonly type: "final";
            };
            readonly consuming: {
                readonly on: {
                    readonly LOST: {
                        readonly target: "releasing";
                    };
                    readonly RETRYING: {
                        readonly target: "retrying";
                    };
                    readonly STOP: {
                        readonly target: "releasing";
                    };
                };
            };
            readonly releasing: {
                readonly on: {
                    readonly RELEASED: {
                        readonly target: "closed";
                    };
                };
            };
            readonly retrying: {
                readonly on: {
                    readonly ACQUIRED: {
                        readonly target: "consuming";
                    };
                    readonly LOST: {
                        readonly target: "releasing";
                    };
                    readonly STOP: {
                        readonly target: "releasing";
                    };
                };
            };
            readonly waiting: {
                readonly on: {
                    readonly RETRY: {
                        readonly target: "acquiring";
                    };
                };
            };
        };
    };
} & {
    readonly id: "mailbox-consumer";
    readonly version: undefined;
};
export interface MessageMeta {
    readonly ack: Effect.Effect<void, MailboxClientError>;
    readonly redelivered: boolean;
    readonly seq: number;
}
export interface Skipped {
    readonly messageId: string;
    readonly reason: "expired" | "settled" | "unopenable";
    readonly senderDid: string;
    readonly seq: number;
}
export interface ConsumeOptions {
    readonly onRetryMetric?: RetryObserver;
    readonly onAttentionReceipt?: (receipt: AttentionReceipt.MainValue) => Effect.Effect<void>;
    readonly ackOnReturn?: boolean;
    readonly harness: Lease.MainValue["harness"];
    readonly renders?: readonly string[];
    readonly resume?: LeaseFence;
    readonly afterSeq?: number;
    readonly onLease?: (lease: Lease.MainValue) => Effect.Effect<void>;
    readonly onRetry?: (error: MailboxClientError) => Effect.Effect<void>;
    readonly leaseName?: string;
    readonly failOnHeld?: boolean;
    readonly unopenable?: (event: Defs.MessageEventValue, error: MailboxClientError) => Effect.Effect<Option.Option<OpenedMessage>>;
    readonly onSkip?: (skipped: Skipped) => Effect.Effect<void>;
}
export declare const consume: <E, R>(mailbox: typeof RatKingMailbox.Service, did: string, handler: (message: OpenedMessage, meta: MessageMeta) => Effect.Effect<void, E, R>, options: ConsumeOptions) => Effect.Effect<void, E | MailboxClientError, R>;
