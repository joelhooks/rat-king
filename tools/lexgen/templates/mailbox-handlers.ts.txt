import { Context } from "effect";
import type { Effect } from "effect";

import type * as Ack from "./mailbox.ack.ts";
import type * as List from "./mailbox.list.ts";
import type * as Send from "./mailbox.send.ts";
import type { XrpcFailure } from "./xrpc-failure.ts";

export interface HandlerInterface {
  readonly send: (
    input: Send.InputValue
  ) => Effect.Effect<Send.OutputValue, XrpcFailure>;
  readonly ack: (
    input: Ack.InputValue
  ) => Effect.Effect<Ack.OutputValue, XrpcFailure>;
  readonly list: (
    params: List.ParamsValue
  ) => Effect.Effect<List.OutputValue, XrpcFailure>;
}

export class MailboxHandlers extends Context.Service<
  MailboxHandlers,
  HandlerInterface
>()("@rat-king/lexicon/MailboxHandlers") {}
