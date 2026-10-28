import * as GetPreferences from "@rat-king/lexicon/attention.getPreferences";
import * as GetStatus from "@rat-king/lexicon/attention.getStatus";
import * as PutPreferences from "@rat-king/lexicon/attention.putPreferences";
import * as PutStatus from "@rat-king/lexicon/attention.putStatus";
import * as Runtime from "@rat-king/lexicon/runtime";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { Effect, Schema } from "effect";

import type { Bindings } from "./bindings.ts";
import type { FailureScope } from "./failure-log.ts";
import { failure } from "./failure.ts";
import { jsonResponse } from "./json-response.ts";
import { trafficDid } from "./traffic-store.ts";

export const attentionMethods = [
  GetPreferences.Method,
  GetStatus.Method,
  PutPreferences.Method,
  PutStatus.Method,
];

const attentionTransport = Effect.fn("Attention.transport")(
  function* attentionTransport(request: Request, nsid: string) {
    if (nsid === GetPreferences.Method.nsid || nsid === GetStatus.Method.nsid) {
      if (request.method !== "GET") {
        return yield* Effect.fail(failure("InvalidRequest"));
      }

      const entries = [...new URL(request.url).searchParams.entries()];

      const params = yield* nsid === GetPreferences.Method.nsid
        ? GetPreferences.decodeParams(entries)
        : GetStatus.decodeParams(entries);

      return {
        did: params.did,
        transport: {
          input: undefined,
          method: "GET",
          nsid,
          params: yield* Schema.encodeEffect(GetStatus.Params)(params),
        } satisfies XrpcRequest,
      };
    }

    if (
      request.method !== "POST" ||
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    ) {
      return yield* Effect.fail(failure("InvalidRequest"));
    }

    const json = yield* Effect.tryPromise({
      catch: () => failure("InvalidRequest"),
      try: request.json.bind(request),
    });

    const input = yield* nsid === PutPreferences.Method.nsid
      ? Schema.decodeUnknownEffect(PutPreferences.Input)(json)
      : Schema.decodeUnknownEffect(PutStatus.Input)(json);

    const encoded = yield* Schema.decodeUnknownEffect(
      Schema.toEncoded(Runtime.Data)
    )(json);

    return {
      did: input.did,
      transport: {
        input: encoded,
        method: "POST",
        nsid,
        params: undefined,
      } satisfies XrpcRequest,
    };
  }
);

export const attentionRequest = Effect.fn("Attention.request")(
  function* attentionRequest(
    request: Request,
    env: Bindings,
    nsid: string,
    caller: string,
    scope: FailureScope
  ) {
    const { did, transport } = yield* attentionTransport(request, nsid).pipe(
      Effect.mapError(() => failure("InvalidRequest"))
    );

    if (did === trafficDid) {
      return yield* Effect.fail(failure("Forbidden", 403));
    }

    scope.recipient = did;
    const mailbox = env.MAILBOX.getByName(did);

    const response = yield* Effect.tryPromise({
      catch: () => failure("MailboxUnavailable", 503),
      try: mailbox.route.bind(mailbox, transport, caller),
    });

    return jsonResponse(response.body, response.status);
  }
);
