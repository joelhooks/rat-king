import { Context, Effect, Layer, Result, Schema } from "effect";

import * as Ack from "./mailbox.ack.ts";
import * as List from "./mailbox.list.ts";
import * as Send from "./mailbox.send.ts";
import * as Runtime from "./runtime.ts";
import type { TransportFailure } from "./transport-failure.ts";
import { Transport } from "./transport.ts";
import type { Response } from "./transport.ts";
import { XrpcFailure } from "./xrpc-failure.ts";

const responseBody = Effect.fn("lexicon.responseBody")(function* responseBody(
  response: Response
) {
  if (response.kind !== "json") {
    return yield* new XrpcFailure({
      error: "NonJsonResponse",
      response: response.body,
      status: response.status,
    });
  }

  if (response.status < 200 || response.status >= 300) {
    const result = yield* Schema.decodeUnknownEffect(Runtime.XrpcErrorBody)(
      response.body
    ).pipe(Effect.result);

    if (Result.isSuccess(result)) {
      return yield* new XrpcFailure({
        error: result.success.error,
        status: response.status,
        ...(result.success.message === undefined
          ? { response: result.success }
          : { message: result.success.message, response: result.success }),
      });
    }

    return yield* new XrpcFailure({
      error: "InvalidErrorResponse",
      response: { body: response.body },
      status: response.status,
    });
  }

  return response.body;
});

export interface MailboxInterface {
  readonly send: (
    input: Send.InputValue
  ) => Effect.Effect<
    Send.OutputValue,
    Schema.SchemaError | XrpcFailure | TransportFailure
  >;
  readonly ack: (
    input: Ack.InputValue
  ) => Effect.Effect<
    Ack.OutputValue,
    Schema.SchemaError | XrpcFailure | TransportFailure
  >;
  readonly list: (
    params: List.ParamsValue
  ) => Effect.Effect<
    List.OutputValue,
    Schema.SchemaError | XrpcFailure | TransportFailure
  >;
}

export class MailboxClient extends Context.Service<
  MailboxClient,
  MailboxInterface
>()("@rat-king/lexicon/MailboxClient") {}

export const clientLayer = Layer.effect(
  MailboxClient,
  Effect.gen(function* clientLayer() {
    const transport = yield* Transport;

    return MailboxClient.of({
      ack: Effect.fn("lexicon.ack")(function* invoke(input) {
        const body = yield* Schema.encodeEffect(Ack.Input)(input);

        const response = yield* transport.request({
          input: body,
          method: Ack.Method.method,
          nsid: Ack.Method.nsid,
          params: undefined,
        });

        return yield* Schema.decodeUnknownEffect(Ack.Output)(
          yield* responseBody(response)
        );
      }),
      list: Effect.fn("lexicon.list")(function* invoke(params) {
        const encoded = yield* Schema.encodeEffect(List.Params)({
          ...List.Method.defaults,
          ...params,
        });

        const response = yield* transport.request({
          input: undefined,
          method: List.Method.method,
          nsid: List.Method.nsid,
          params: encoded,
        });

        return yield* Schema.decodeUnknownEffect(List.Output)(
          yield* responseBody(response)
        );
      }),
      send: Effect.fn("lexicon.send")(function* invoke(input) {
        const body = yield* Schema.encodeEffect(Send.Input)(input);

        const response = yield* transport.request({
          input: body,
          method: Send.Method.method,
          nsid: Send.Method.nsid,
          params: undefined,
        });

        return yield* Schema.decodeUnknownEffect(Send.Output)(
          yield* responseBody(response)
        );
      }),
    });
  })
);
