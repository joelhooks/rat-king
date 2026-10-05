import { Context } from "effect";
import type { Effect } from "effect";

import type * as Runtime from "./runtime.ts";
import type { TransportFailure } from "./transport-failure.ts";

export interface Request {
  readonly nsid: string;
  readonly method: "GET" | "POST";
  readonly params: Runtime.LexJsonMap | undefined;
  readonly input: Runtime.LexJson | undefined;
}

export type Response =
  | {
      readonly kind: "json";
      readonly status: number;
      readonly body: Runtime.LexJson;
    }
  | { readonly kind: "text"; readonly status: number; readonly body: string };

export class Transport extends Context.Service<
  Transport,
  {
    readonly request: (
      request: Request
    ) => Effect.Effect<Response, TransportFailure>;
  }
>()("@rat-king/lexicon/Transport") {}
