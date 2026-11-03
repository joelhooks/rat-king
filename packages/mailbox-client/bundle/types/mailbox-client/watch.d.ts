import { Context, Effect, Stream } from "effect";
import { Socket } from "effect/socket";
import { MailboxClientError } from "./error.js";
import type { Batch, ClientConfig, LeaseFence } from "./mailbox.js";
declare const WebSocketPort_base: Context.ServiceClass<WebSocketPort, "@rat-king/mailbox-client/WebSocketPort", {
    readonly connect: (url: string) => Socket.WebSocketLike;
}>;
export declare class WebSocketPort extends WebSocketPort_base {
}
export declare const watch: (config: ClientConfig, poll: (afterSeq: number) => Effect.Effect<Batch, MailboxClientError>, afterSeq: number, fence: LeaseFence, onRetry?: (error: MailboxClientError) => Effect.Effect<void>) => Stream.Stream<Batch, MailboxClientError>;
export {};
