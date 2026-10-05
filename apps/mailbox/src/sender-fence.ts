import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import type { Effect } from "effect";
import { Context } from "effect";

export class SenderFence extends Context.Service<
  SenderFence,
  {
    readonly check: (
      did: string,
      fence: { readonly leaseId?: string; readonly generation?: number }
    ) => Effect.Effect<void, XrpcFailure>;
  }
>()("mailbox/SenderFence") {}
