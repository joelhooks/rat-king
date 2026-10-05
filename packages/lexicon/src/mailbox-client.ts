import { Context, Effect, Layer, Result, Schema } from "effect";

import * as PutDidDocument from "./admin.putDidDocument.ts";
import * as Ack from "./mailbox.ack.ts";
import * as Deliver from "./mailbox.deliver.ts";
import * as List from "./mailbox.list.ts";
import * as Send from "./mailbox.send.ts";
import * as AcquireLease from "./runtime.acquireLease.ts";
import * as ReleaseLease from "./runtime.releaseLease.ts";
import * as RenewLease from "./runtime.renewLease.ts";
import * as ResolveLease from "./runtime.resolveLease.ts";
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
  readonly acquireLease: (
    input: AcquireLease.InputValue
  ) => Effect.Effect<
    AcquireLease.OutputValue,
    Schema.SchemaError | XrpcFailure | TransportFailure
  >;
  readonly renewLease: (
    input: RenewLease.InputValue
  ) => Effect.Effect<
    RenewLease.OutputValue,
    Schema.SchemaError | XrpcFailure | TransportFailure
  >;
  readonly releaseLease: (
    input: ReleaseLease.InputValue
  ) => Effect.Effect<
    ReleaseLease.OutputValue,
    Schema.SchemaError | XrpcFailure | TransportFailure
  >;
  readonly resolveLease: (
    params: ResolveLease.ParamsValue
  ) => Effect.Effect<
    ResolveLease.OutputValue,
    Schema.SchemaError | XrpcFailure | TransportFailure
  >;
  readonly deliver: (
    input: Deliver.InputValue
  ) => Effect.Effect<
    Deliver.OutputValue,
    Schema.SchemaError | XrpcFailure | TransportFailure
  >;
  readonly putDidDocument: (
    input: PutDidDocument.InputValue
  ) => Effect.Effect<
    PutDidDocument.OutputValue,
    Schema.SchemaError | XrpcFailure | TransportFailure
  >;
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
      acquireLease: Effect.fn("lexicon.acquireLease")(function* invoke(input) {
        const encoded = yield* Schema.encodeEffect(AcquireLease.Input)(input);

        const response = yield* transport.request({
          input: encoded,
          method: AcquireLease.Method.method,
          nsid: AcquireLease.Method.nsid,
          params: undefined,
        });

        return yield* Schema.decodeUnknownEffect(AcquireLease.Output)(
          yield* responseBody(response)
        );
      }),
      deliver: Effect.fn("lexicon.deliver")(function* invoke(input) {
        const encoded = yield* Schema.encodeEffect(Deliver.Input)(input);

        const response = yield* transport.request({
          input: encoded,
          method: Deliver.Method.method,
          nsid: Deliver.Method.nsid,
          params: undefined,
        });

        return yield* Schema.decodeUnknownEffect(Deliver.Output)(
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
      putDidDocument: Effect.fn("lexicon.putDidDocument")(
        function* invoke(input) {
          const encoded = yield* Schema.encodeEffect(PutDidDocument.Input)(
            input
          );

          const response = yield* transport.request({
            input: encoded,
            method: PutDidDocument.Method.method,
            nsid: PutDidDocument.Method.nsid,
            params: undefined,
          });

          return yield* Schema.decodeUnknownEffect(PutDidDocument.Output)(
            yield* responseBody(response)
          );
        }
      ),
      releaseLease: Effect.fn("lexicon.releaseLease")(function* invoke(input) {
        const encoded = yield* Schema.encodeEffect(ReleaseLease.Input)(input);

        const response = yield* transport.request({
          input: encoded,
          method: ReleaseLease.Method.method,
          nsid: ReleaseLease.Method.nsid,
          params: undefined,
        });

        if (
          response.status === 204 &&
          response.kind === "text" &&
          response.body === ""
        ) {
          const output: ReleaseLease.OutputValue = undefined;

          return yield* Schema.decodeEffect(ReleaseLease.Output)(output);
        }

        return yield* Schema.decodeUnknownEffect(ReleaseLease.Output)(
          yield* responseBody(response)
        );
      }),
      renewLease: Effect.fn("lexicon.renewLease")(function* invoke(input) {
        const encoded = yield* Schema.encodeEffect(RenewLease.Input)(input);

        const response = yield* transport.request({
          input: encoded,
          method: RenewLease.Method.method,
          nsid: RenewLease.Method.nsid,
          params: undefined,
        });

        return yield* Schema.decodeUnknownEffect(RenewLease.Output)(
          yield* responseBody(response)
        );
      }),
      resolveLease: Effect.fn("lexicon.resolveLease")(function* invoke(params) {
        const encoded = yield* Schema.encodeEffect(ResolveLease.Params)({
          ...ResolveLease.Method.defaults,
          ...params,
        });

        const response = yield* transport.request({
          input: undefined,
          method: ResolveLease.Method.method,
          nsid: ResolveLease.Method.nsid,
          params: encoded,
        });

        return yield* Schema.decodeUnknownEffect(ResolveLease.Output)(
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
