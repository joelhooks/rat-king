import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ClaimsValue } from "./auth.ts";

export interface ReplayInterface {
  readonly consume: (
    claims: ClaimsValue,
    now: number
  ) => Effect.Effect<void, XrpcFailure>;
}

export class ReplayAuthority extends Context.Service<
  ReplayAuthority,
  ReplayInterface
>()("mailbox/ReplayAuthority") {}
