import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Context } from "effect";
import type { Effect } from "effect";

export interface SenderReservationInterface {
  readonly reserve: (
    senderDid: string,
    messageId: string,
    recipientDid: string,
    canonicalBytes: Uint8Array
  ) => Effect.Effect<void, XrpcFailure>;
}

export class SenderReservation extends Context.Service<
  SenderReservation,
  SenderReservationInterface
>()("mailbox/SenderReservation") {}
