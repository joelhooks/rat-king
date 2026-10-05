import type { EnvelopeFailure } from "@rat-king/envelope";
import { Context } from "effect";
import type { Effect } from "effect";

export interface LoopKeys {
  readonly agreement: CryptoKey;
  readonly did: string;
  readonly resolve: (
    did: string,
    keyId: string,
    purpose: "authentication" | "keyAgreement"
  ) => Effect.Effect<CryptoKey, EnvelopeFailure>;
  readonly signing: CryptoKey;
}

export class AgentKeys extends Context.Service<AgentKeys, LoopKeys>()(
  "@rat-king/AgentKeys"
) {}
