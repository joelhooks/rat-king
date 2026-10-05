import { Context, Effect, Layer, Schema } from "effect";

import * as PutDidDocument from "./admin.putDidDocument.ts";
import { MailboxHandlers } from "./mailbox-handlers.ts";
import * as Ack from "./mailbox.ack.ts";
import * as Deliver from "./mailbox.deliver.ts";
import * as List from "./mailbox.list.ts";
import * as Send from "./mailbox.send.ts";
import * as AcquireLease from "./runtime.acquireLease.ts";
import * as ReleaseLease from "./runtime.releaseLease.ts";
import * as RenewLease from "./runtime.renewLease.ts";
import * as ResolveLease from "./runtime.resolveLease.ts";
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

    const acquireLease: Route = {
      handle: Effect.fn("lexicon.route.acquireLease")(
        function* route(request) {
          yield* validateRoute(
            request,
            AcquireLease.Method.nsid,
            AcquireLease.Method.method
          );

          const input = yield* Schema.decodeUnknownEffect(AcquireLease.Input)(
            request.input
          );

          const output = yield* handlers.acquireLease(input);

          return {
            body: yield* Schema.encodeEffect(AcquireLease.Output)(output),
            kind: "json",
            status: 200,
          } satisfies Response;
        },
        Effect.catchTag("XrpcFailure", encodeFailure)
      ),
      method: AcquireLease.Method.method,
      nsid: AcquireLease.Method.nsid,
      path: AcquireLease.Method.path,
    };

    const renewLease: Route = {
      handle: Effect.fn("lexicon.route.renewLease")(
        function* route(request) {
          yield* validateRoute(
            request,
            RenewLease.Method.nsid,
            RenewLease.Method.method
          );

          const input = yield* Schema.decodeUnknownEffect(RenewLease.Input)(
            request.input
          );

          const output = yield* handlers.renewLease(input);

          return {
            body: yield* Schema.encodeEffect(RenewLease.Output)(output),
            kind: "json",
            status: 200,
          } satisfies Response;
        },
        Effect.catchTag("XrpcFailure", encodeFailure)
      ),
      method: RenewLease.Method.method,
      nsid: RenewLease.Method.nsid,
      path: RenewLease.Method.path,
    };

    const releaseLease: Route = {
      handle: Effect.fn("lexicon.route.releaseLease")(
        function* route(request) {
          yield* validateRoute(
            request,
            ReleaseLease.Method.nsid,
            ReleaseLease.Method.method
          );

          const input = yield* Schema.decodeUnknownEffect(ReleaseLease.Input)(
            request.input
          );

          const output = yield* handlers.releaseLease(input);

          yield* Schema.encodeEffect(ReleaseLease.Output)(output);

          return { body: "", kind: "text", status: 204 } satisfies Response;
        },
        Effect.catchTag("XrpcFailure", encodeFailure)
      ),
      method: ReleaseLease.Method.method,
      nsid: ReleaseLease.Method.nsid,
      path: ReleaseLease.Method.path,
    };

    const resolveLease: Route = {
      handle: Effect.fn("lexicon.route.resolveLease")(
        function* route(request) {
          yield* validateRoute(
            request,
            ResolveLease.Method.nsid,
            ResolveLease.Method.method
          );

          const params = yield* Schema.decodeUnknownEffect(ResolveLease.Params)(
            request.params
          );

          const output = yield* handlers.resolveLease(params);

          return {
            body: yield* Schema.encodeEffect(ResolveLease.Output)(output),
            kind: "json",
            status: 200,
          } satisfies Response;
        },
        Effect.catchTag("XrpcFailure", encodeFailure)
      ),
      method: ResolveLease.Method.method,
      nsid: ResolveLease.Method.nsid,
      path: ResolveLease.Method.path,
    };

    const deliver: Route = {
      handle: Effect.fn("lexicon.route.deliver")(
        function* route(request) {
          yield* validateRoute(
            request,
            Deliver.Method.nsid,
            Deliver.Method.method
          );

          const input = yield* Schema.decodeUnknownEffect(Deliver.Input)(
            request.input
          );

          const output = yield* handlers.deliver(input);

          return {
            body: yield* Schema.encodeEffect(Deliver.Output)(output),
            kind: "json",
            status: 200,
          } satisfies Response;
        },
        Effect.catchTag("XrpcFailure", encodeFailure)
      ),
      method: Deliver.Method.method,
      nsid: Deliver.Method.nsid,
      path: Deliver.Method.path,
    };

    const putDidDocument: Route = {
      handle: Effect.fn("lexicon.route.putDidDocument")(
        function* route(request) {
          yield* validateRoute(
            request,
            PutDidDocument.Method.nsid,
            PutDidDocument.Method.method
          );

          const input = yield* Schema.decodeUnknownEffect(PutDidDocument.Input)(
            request.input
          );

          const output = yield* handlers.putDidDocument(input);

          return {
            body: yield* Schema.encodeEffect(PutDidDocument.Output)(output),
            kind: "json",
            status: 200,
          } satisfies Response;
        },
        Effect.catchTag("XrpcFailure", encodeFailure)
      ),
      method: PutDidDocument.Method.method,
      nsid: PutDidDocument.Method.nsid,
      path: PutDidDocument.Method.path,
    };

    return MailboxServer.of({
      routes: new Map([
        [acquireLease.path, acquireLease],
        [renewLease.path, renewLease],
        [releaseLease.path, releaseLease],
        [resolveLease.path, resolveLease],
        [deliver.path, deliver],
        [putDidDocument.path, putDidDocument],
        [send.path, send],
        [ack.path, ack],
        [list.path, list],
      ]),
    });
  })
);
