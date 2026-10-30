import * as ResolveRecipient from "@rat-king/lexicon/identity.resolveRecipient";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Effect, Option, Schema } from "effect";

import { failure } from "./failure.ts";

export type IssuerRoute = (
  request: XrpcRequest
) => Effect.Effect<
  { readonly status: number; readonly body: string },
  XrpcFailure
>;

const IssuerRefusal = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.String,
    message: Schema.optionalKey(Schema.String),
  })
);

export const confirmResolution = Effect.fn("Mailbox.confirmResolution")(
  function* confirmResolution(
    route: IssuerRoute | undefined,
    resolvedFrom: string,
    recipient: string
  ) {
    if (route === undefined) {
      return yield* failure(
        "MailboxUnavailable",
        503,
        "No issuer resolves resolvedFrom here"
      );
    }

    const response = yield* route({
      input: undefined,
      method: "GET",
      nsid: ResolveRecipient.Method.nsid,
      params: { name: resolvedFrom },
    });

    if (response.status !== 200) {
      const refusal = Schema.decodeUnknownOption(IssuerRefusal)(response.body);

      return yield* Option.match(refusal, {
        onNone: () => failure("MailboxUnavailable", 503),
        onSome: (body) =>
          failure(body.error, response.status, body.message ?? body.error),
      });
    }

    const resolved = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ResolveRecipient.Output)
    )(response.body).pipe(
      Effect.mapError(() => failure("MailboxUnavailable", 503))
    );

    if (resolved.did !== recipient) {
      return yield* failure(
        "RoleUnresolved",
        409,
        `${resolvedFrom} now resolves to ${resolved.name} (${resolved.chain.join(" → ")}), not this envelope's recipient; resolve it again and seal to the new recipient. Nothing was admitted.`
      );
    }

    return yield* Effect.void;
  }
);
