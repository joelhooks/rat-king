import { Context, Effect, Layer, Schema } from "effect";

import { MailboxHandlers } from "./mailbox-handlers.ts";
import * as Ack from "./mailbox.ack.ts";
import * as List from "./mailbox.list.ts";
import * as Send from "./mailbox.send.ts";
import * as Runtime from "./runtime.ts";
import type { Request, Response } from "./transport.ts";
import { XrpcFailure } from "./xrpc-failure.ts";

export interface Route {
  readonly nsid: string;
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly handle: (
    request: Request
  ) => Effect.Effect<Response, Schema.SchemaError>;
}

export class MailboxServer extends Context.Service<
  MailboxServer,
  {
    readonly routes: ReadonlyMap<string, Route>;
  }
>()("@rat-king/lexicon/MailboxServer") {}

const encodeFailure = Effect.fn("lexicon.encodeFailure")(
  function* encodeFailure(failure: XrpcFailure) {
    const body = yield* Schema.encodeEffect(Runtime.XrpcErrorBody)(
      failure.message === undefined
        ? { error: failure.error }
        : { error: failure.error, message: failure.message }
    );

    return { body, kind: "json", status: failure.status } satisfies Response;
  }
);

const validateRoute = (
  request: Request,
  nsid: string,
  method: "GET" | "POST"
) =>
  request.nsid === nsid && request.method === method
    ? Effect.void
    : Effect.fail(
        new XrpcFailure({
          error: "InvalidRequest",
          response: { error: "InvalidRequest" },
          status: 400,
        })
      );

export const serverLayer = Layer.effect(
  MailboxServer,
  Effect.gen(function* serverLayer() {
    const handlers = yield* MailboxHandlers;

    const send: Route = {
      handle: Effect.fn("lexicon.route.send")(
        function* route(request) {
          yield* validateRoute(request, Send.Method.nsid, Send.Method.method);

          const input = yield* Schema.decodeUnknownEffect(Send.Input)(
            request.input
          );

          const output = yield* handlers.send(input);

          return {
            body: yield* Schema.encodeEffect(Send.Output)(output),
            kind: "json",
            status: 200,
          } satisfies Response;
        },
        Effect.catchTag("XrpcFailure", encodeFailure)
      ),
      method: Send.Method.method,
      nsid: Send.Method.nsid,
      path: Send.Method.path,
    };

    const ack: Route = {
      handle: Effect.fn("lexicon.route.ack")(
        function* route(request) {
          yield* validateRoute(request, Ack.Method.nsid, Ack.Method.method);

          const input = yield* Schema.decodeUnknownEffect(Ack.Input)(
            request.input
          );

          const output = yield* handlers.ack(input);

          return {
            body: yield* Schema.encodeEffect(Ack.Output)(output),
            kind: "json",
            status: 200,
          } satisfies Response;
        },
        Effect.catchTag("XrpcFailure", encodeFailure)
      ),
      method: Ack.Method.method,
      nsid: Ack.Method.nsid,
      path: Ack.Method.path,
    };

    const list: Route = {
      handle: Effect.fn("lexicon.route.list")(
        function* route(request) {
          yield* validateRoute(request, List.Method.nsid, List.Method.method);

          const params = yield* Schema.decodeUnknownEffect(List.Params)(
            request.params
          );

          const output = yield* handlers.list(params);

          return {
            body: yield* Schema.encodeEffect(List.Output)(output),
            kind: "json",
            status: 200,
          } satisfies Response;
        },
        Effect.catchTag("XrpcFailure", encodeFailure)
      ),
      method: List.Method.method,
      nsid: List.Method.nsid,
      path: List.Method.path,
    };

    return MailboxServer.of({
      routes: new Map([
        [send.path, send],
        [ack.path, ack],
        [list.path, list],
      ]),
    });
  })
);
