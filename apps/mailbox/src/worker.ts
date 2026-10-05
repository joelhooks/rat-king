/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import { MailboxServer, serverLayer } from "@rat-king/lexicon/mailbox-server";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Send from "@rat-king/lexicon/mailbox.send";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { DurableObject } from "cloudflare:workers";
import { Clock, Effect, Layer, Schema } from "effect";

import {
  authenticate,
  Documents,
  ReplayAuthority,
  staticResolver,
} from "./auth.ts";
import type { Bindings } from "./bindings.ts";
import { failure } from "./failure.ts";
import {
  Caller,
  handlersLayer,
  LeaseAuthority,
  leaseLayer,
} from "./mailbox.ts";
import { proofLeasePath, ProofLease } from "./proof-lease.ts";
import { sqliteStore } from "./sqlite.ts";
import type { LeaseValue } from "./store.ts";
import { TerminalDelivery, terminalLayer } from "./terminal.ts";

declare const __BUNDLE_VERSION__: string;

declare const __BUNDLE_COMMIT__: string;

export const bundle = {
  commit: __BUNDLE_COMMIT__,
  version: __BUNDLE_VERSION__,
};

const documentsLayer = (env: Bindings) =>
  staticResolver(
    Schema.decodeUnknownSync(Documents)(JSON.parse(env.DID_DOCUMENTS))
  );

const errorResponse = (error: XrpcFailure) =>
  Response.json(
    { error: error.error, message: error.message },
    { status: error.status }
  );

export class Mailbox extends DurableObject<Bindings> {
  private readonly store;
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const recipient = ctx.id.name;

    if (recipient?.startsWith("did:web:") !== true) {
      throw failure("Forbidden", 403);
    }

    this.store = sqliteStore(
      {
        exec: (query, ...values) => ctx.storage.sql.exec(query, ...values),
        transaction: (operation) => ctx.storage.transactionSync(operation),
      },
      recipient
    );
  }
  route(request: XrpcRequest, issuer: string) {
    const layer = handlersLayer.pipe(
      Layer.provide(this.store),
      Layer.provide(Layer.succeed(Caller, { did: issuer })),
      Layer.provide(documentsLayer(this.env))
    );

    return Effect.runPromise(
      Effect.gen(function* step1() {
        const server = yield* MailboxServer;
        const route = server.routes.get(`/xrpc/${request.nsid}`);

        if (!route) {
          return {
            body: { error: "InvalidRequest" },
            kind: "json",
            status: 404,
          };
        }

        return yield* route.handle(request).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.succeed({
              body: { error: "InvalidRequest" },
              kind: "json",
              status: 400,
            })
          )
        );
      }).pipe(
        Effect.map((response) => ({
          body: JSON.stringify(response.body),
          status: response.status,
        })),
        Effect.provide(serverLayer.pipe(Layer.provide(layer)))
      )
    );
  }
  acquireLease(leaseId: string, ttl: number): Promise<LeaseValue> {
    return Effect.runPromise(
      Effect.gen(function* step2() {
        const leases = yield* LeaseAuthority;

        return yield* leases.acquire(leaseId, ttl);
      }).pipe(Effect.provide(leaseLayer.pipe(Layer.provide(this.store))))
    );
  }
  renewLease(
    leaseId: string,
    generation: number,
    ttl: number
  ): Promise<LeaseValue> {
    return Effect.runPromise(
      Effect.gen(function* step3() {
        const leases = yield* LeaseAuthority;

        return yield* leases.renew(leaseId, generation, ttl);
      }).pipe(Effect.provide(leaseLayer.pipe(Layer.provide(this.store))))
    );
  }
  releaseLease(leaseId: string, generation: number): Promise<void> {
    return Effect.runPromise(
      Effect.gen(function* step4() {
        const leases = yield* LeaseAuthority;

        return yield* leases.release(leaseId, generation);
      }).pipe(Effect.provide(leaseLayer.pipe(Layer.provide(this.store))))
    );
  }
  settle(sender: string, tid: string, command: "expire" | "fail") {
    return Effect.runPromise(
      Effect.gen(function* settleDelivery() {
        const terminal = yield* TerminalDelivery;

        return JSON.stringify(yield* terminal.settle(sender, tid, command));
      }).pipe(Effect.provide(terminalLayer.pipe(Layer.provide(this.store))))
    );
  }

  inject(sender: string, tid: string, leaseId: string, generation: number) {
    return Effect.runPromise(
      Effect.gen(function* step5() {
        const leases = yield* LeaseAuthority;

        return JSON.stringify(
          yield* leases.inject(sender, tid, leaseId, generation)
        );
      }).pipe(Effect.provide(leaseLayer.pipe(Layer.provide(this.store))))
    );
  }
}

const replayLayer = (env: Bindings) =>
  Layer.succeed(
    ReplayAuthority,
    ReplayAuthority.of({
      consume: Effect.fn("AuthTokens.consume")(function* consume(claims, now) {
        const accepted = yield* Effect.tryPromise({
          catch: () => failure("MailboxUnavailable", 503),
          try: () =>
            env.AUTH_TOKENS.getByName(env.SERVICE_DID).consume(
              claims.iss,
              claims.jti,
              claims.exp,
              now
            ),
        });

        if (!accepted) {
          return yield* Effect.fail(
            failure("AuthRequired", 401, "Reused service token")
          );
        }

        return yield* Effect.void;
      }),
    })
  );

export const fetchRequest = (request: Request, env: Bindings) =>
  Effect.gen(function* handleRequest() {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/rat-king/version") {
      return Response.json(bundle);
    }

    if (url.pathname === proofLeasePath) {
      if (
        request.method !== "POST" ||
        request.headers.get("content-type")?.split(";")[0] !==
          "application/json"
      ) {
        return yield* failure("InvalidRequest");
      }

      const issuer = yield* authenticate({
        audience: `${env.SERVICE_DID}#mailbox`,
        authorization: request.headers.get("authorization"),
        now: yield* Clock.currentTimeMillis,
        nsid: proofLeasePath,
      }).pipe(
        Effect.provide(Layer.merge(documentsLayer(env), replayLayer(env)))
      );

      const input = yield* Schema.decodeUnknownEffect(ProofLease)(
        yield* Effect.tryPromise({
          catch: () => failure("InvalidRequest"),
          try: () => request.json(),
        })
      ).pipe(Effect.mapError(() => failure("InvalidRequest")));

      const lease = yield* Effect.tryPromise({
        catch: () => failure("MailboxUnavailable", 503),
        try: () => {
          const mailbox = env.MAILBOX.getByName(issuer);

          return input.generation === undefined
            ? mailbox.acquireLease(input.leaseId, input.ttl)
            : mailbox.renewLease(input.leaseId, input.generation, input.ttl);
        },
      });

      if (input.message !== undefined) {
        const { message } = input;
        yield* Effect.tryPromise({
          catch: () => failure("MailboxUnavailable", 503),
          try: () =>
            env.MAILBOX.getByName(issuer).inject(
              message.senderDid,
              message.messageId,
              lease.leaseId,
              lease.generation
            ),
        });
      }

      return Response.json(lease);
    }

    const nsid = url.pathname.slice("/xrpc/".length);

    if (
      !url.pathname.startsWith("/xrpc/") ||
      ![Send.Method.nsid, Ack.Method.nsid, List.Method.nsid].some(
        (method) => method === nsid
      )
    ) {
      return Response.json({ error: "InvalidRequest" }, { status: 404 });
    }

    const now = yield* Clock.currentTimeMillis;

    const issuer = yield* authenticate({
      audience: `${env.SERVICE_DID}#mailbox`,
      authorization: request.headers.get("authorization"),
      now,
      nsid,
    }).pipe(Effect.provide(Layer.merge(documentsLayer(env), replayLayer(env))));

    let recipient: string;
    let transport: XrpcRequest;

    if (nsid === List.Method.nsid) {
      if (request.method !== "GET") {
        return yield* Effect.fail(failure("InvalidRequest"));
      }

      const params = yield* List.decodeParams([
        ...url.searchParams.entries(),
      ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

      recipient = params.recipientDid;
      transport = {
        input: undefined,
        method: "GET",
        nsid,
        params: yield* Schema.encodeEffect(List.Params)(params),
      };
    } else {
      if (
        request.method !== "POST" ||
        request.headers.get("content-type")?.split(";")[0] !==
          "application/json"
      ) {
        return yield* Effect.fail(failure("InvalidRequest"));
      }

      const input = yield* Effect.tryPromise({
        catch: () => failure("InvalidRequest"),
        try: () => request.json(),
      });

      if (nsid === Send.Method.nsid) {
        const decoded = yield* Schema.decodeUnknownEffect(Send.Input)(
          input
        ).pipe(Effect.mapError(() => failure("InvalidRequest")));

        recipient = decoded.envelope.aad.recipientDid;
        transport = {
          input: yield* Schema.encodeEffect(Send.Input)(decoded),
          method: "POST",
          nsid,
          params: undefined,
        };
      } else {
        const decoded = yield* Schema.decodeUnknownEffect(Ack.Input)(
          input
        ).pipe(Effect.mapError(() => failure("InvalidRequest")));

        recipient = decoded.recipientDid;
        transport = {
          input: yield* Schema.encodeEffect(Ack.Input)(decoded),
          method: "POST",
          nsid,
          params: undefined,
        };
      }
    }

    const response = yield* Effect.tryPromise({
      catch: () => failure("MailboxUnavailable", 503),
      try: () => env.MAILBOX.getByName(recipient).route(transport, issuer),
    });

    return new Response(response.body, {
      headers: { "content-type": "application/json" },
      status: response.status,
    });
  }).pipe(
    Effect.catchTag("XrpcFailure", (error) =>
      Effect.succeed(errorResponse(error))
    )
  );

export default {
  fetch: (request: Request, env: Bindings) =>
    Effect.runPromise(fetchRequest(request, env)),
};

export { AuthTokens } from "./auth-tokens.ts";
