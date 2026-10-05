import * as PutDocument from "@rat-king/lexicon/admin.putDidDocument";
import * as Defs from "@rat-king/lexicon/defs";
/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import { MailboxServer, serverLayer } from "@rat-king/lexicon/mailbox-server";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as Deliver from "@rat-king/lexicon/mailbox.deliver";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Send from "@rat-king/lexicon/mailbox.send";
import * as Subscribe from "@rat-king/lexicon/mailbox.subscribe";
import * as Runtime from "@rat-king/lexicon/runtime";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import * as Resolve from "@rat-king/lexicon/runtime.resolveLease";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { DurableObject } from "cloudflare:workers";
import { Clock, Effect, Layer, Schema } from "effect";

import { authenticate, ReplayAuthority } from "./auth.ts";
import type { Bindings } from "./bindings.ts";
import { documentsLayer, didAllowlist } from "./documents.ts";
import { failure } from "./failure.ts";
import { validLease } from "./lease.ts";
import {
  Caller,
  mailboxHandlers,
  deliverMessage,
  LeaseAuthority,
  leaseLayer,
} from "./mailbox.ts";
import { SenderFence } from "./sender-fence.ts";
import { SocketAttachment, socketStep, socketCodes } from "./socket.ts";
import { sqliteStore } from "./sqlite.ts";
import { MailboxStore } from "./store.ts";
import type { LeaseValue, Event } from "./store.ts";
import { TerminalDelivery, terminalLayer } from "./terminal.ts";

declare const __BUNDLE_VERSION__: string;

declare const __BUNDLE_COMMIT__: string;

export const bundle = {
  commit: __BUNDLE_COMMIT__,
  version: __BUNDLE_VERSION__,
};

const errorResponse = (error: XrpcFailure) =>
  Response.json(
    { error: error.error, message: error.message },
    { status: error.status }
  );

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

export class Mailbox extends DurableObject<Bindings> {
  private readonly store;
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const recipient = ctx.id.name;

    if (recipient?.startsWith("did:web:") !== true) {
      throw failure("Forbidden", 403);
    }

    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS wake_attempts (id INTEGER PRIMARY KEY, sender TEXT NOT NULL, tid TEXT NOT NULL, outcome TEXT NOT NULL)"
    );
    this.store = sqliteStore(
      {
        exec: (query, ...values) => ctx.storage.sql.exec(query, ...values),
        transaction: (operation) => ctx.storage.transactionSync(operation),
      },
      recipient,
      (events, lease) => {
        this.committed(events, lease);
      }
    );
  }
  recordWake(sender: string, tid: string, outcome: "accepted" | "unavailable") {
    this.ctx.storage.sql.exec(
      "INSERT INTO wake_attempts (sender,tid,outcome) VALUES (?,?,?)",
      sender,
      tid,
      outcome
    );
  }

  wakeEvidence() {
    return [
      ...this.ctx.storage.sql.exec(
        "SELECT sender,tid,outcome FROM wake_attempts ORDER BY id"
      ),
    ];
  }

  route(request: XrpcRequest, issuer: string) {
    const { env } = this;

    const layer = mailboxHandlers({
      operators: didAllowlist(this.env.OPERATOR_DIDS),
      resolvers: didAllowlist(this.env.LEASE_RESOLVERS),
      staticDocuments: Schema.decodeSync(
        Schema.fromJsonString(Schema.Array(Defs.DidDocument))
      )(this.env.DID_DOCUMENTS),
    }).pipe(
      Layer.provide(
        Layer.succeed(SenderFence, {
          check: Effect.fn("SenderFence.check")(function* check(
            did: string,
            fence: { readonly leaseId?: string; readonly generation?: number }
          ) {
            const response = yield* Effect.tryPromise({
              catch: () => failure("MailboxUnavailable", 503),
              try: () => env.MAILBOX.getByName(did).checkSend(fence),
            });

            if (!response) {
              return yield* Effect.fail(failure("LeaseMismatch", 409));
            }

            return yield* Effect.void;
          }),
        })
      ),
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
          body: JSON.stringify(response.body) ?? "",
          status: response.status,
        })),
        Effect.provide(serverLayer.pipe(Layer.provide(layer)))
      )
    );
  }
  acquireLease(json: string) {
    const input = Schema.decodeSync(Schema.fromJsonString(Acquire.Input))(json);

    return Effect.runPromise(
      LeaseAuthority.use((leases) => leases.acquire(input)).pipe(
        Effect.map((lease) => JSON.stringify(lease)),
        Effect.provide(leaseLayer.pipe(Layer.provide(this.store)))
      )
    );
  }
  renewLease(json: string) {
    const input = Schema.decodeSync(Schema.fromJsonString(Renew.Input))(json);

    return Effect.runPromise(
      LeaseAuthority.use((leases) => leases.renew(input)).pipe(
        Effect.map((lease) => JSON.stringify(lease)),
        Effect.provide(leaseLayer.pipe(Layer.provide(this.store)))
      )
    );
  }
  releaseLease(json: string) {
    const input = Schema.decodeSync(Schema.fromJsonString(Release.Input))(json);

    return Effect.runPromise(
      LeaseAuthority.use((leases) => leases.release(input)).pipe(
        Effect.provide(leaseLayer.pipe(Layer.provide(this.store)))
      )
    );
  }
  checkSend(fence: {
    readonly leaseId?: string;
    readonly generation?: number;
  }) {
    return Effect.runPromise(
      LeaseAuthority.use((leases) => leases.checkSend(fence)).pipe(
        Effect.as(true),
        Effect.catchTag("XrpcFailure", (error) =>
          error.error === "LeaseMismatch"
            ? Effect.succeed(false)
            : Effect.fail(error)
        ),
        Effect.provide(leaseLayer.pipe(Layer.provide(this.store)))
      )
    );
  }
  registeredDocument() {
    return Effect.runPromise(
      MailboxStore.use((store) =>
        store.transaction((tx) => {
          const document = tx.document();

          return document === undefined ? undefined : JSON.stringify(document);
        })
      ).pipe(Effect.provide(this.store))
    );
  }
  settle(
    sender: string,
    tid: string,
    command: "expire" | "fail",
    detail?: string
  ) {
    return Effect.runPromise(
      Effect.gen(function* settleDelivery() {
        const terminal = yield* TerminalDelivery;

        return JSON.stringify(
          yield* terminal.settle(sender, tid, command, detail)
        );
      }).pipe(Effect.provide(terminalLayer.pipe(Layer.provide(this.store))))
    );
  }

  inject(sender: string, tid: string, leaseId: string, generation: number) {
    return Effect.runPromise(
      Effect.gen(function* inject() {
        const store = yield* MailboxStore;
        const now = yield* Clock.currentTimeMillis;

        return JSON.stringify(
          yield* store.transaction((tx) => {
            validLease(tx, { generation, leaseId }, now);

            return deliverMessage(tx, sender, tid, now);
          })
        );
      }).pipe(Effect.provide(this.store))
    );
  }

  private committed(events: readonly Event[], lease: LeaseValue | undefined) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = Schema.decodeUnknownSync(SocketAttachment)(
        socket.deserializeAttachment()
      );

      if (attachment.state === "closed") {
        continue;
      }

      if (
        !lease ||
        lease.expiresAt <= Effect.runSync(Clock.currentTimeMillis) ||
        lease.leaseId !== attachment.leaseId ||
        lease.generation !== attachment.generation
      ) {
        Mailbox.closeSocket(socket, socketCodes.stale, "Stale lease");
        continue;
      }

      if (attachment.state === "authenticated") {
        for (const event of events) {
          socket.send(
            JSON.stringify({
              $type: "sh.mschf.ratking.mailbox.subscribe#notice",
              seq: event.seq,
            })
          );
        }
      }
    }
  }

  private static closeSocket(socket: WebSocket, code: number, reason: string) {
    const attachment = Schema.decodeUnknownSync(SocketAttachment)(
      socket.deserializeAttachment()
    );

    socket.serializeAttachment(socketStep(attachment, "close"));
    socket.close(code, reason);
  }

  override fetch(request: Request) {
    return Effect.runPromise(
      Effect.gen(
        function* upgrade(this: Mailbox) {
          const url = new URL(request.url);

          if (
            request.method !== "GET" ||
            request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
            [...url.searchParams.keys()].some(
              (key) => !["recipientDid", "leaseId", "generation"].includes(key)
            )
          ) {
            return yield* Effect.fail(failure("InvalidRequest"));
          }

          const params = yield* Subscribe.decodeParams([
            ...url.searchParams.entries(),
          ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

          const store = yield* MailboxStore;
          const now = yield* Clock.currentTimeMillis;
          yield* store.transaction((tx) => {
            if (params.recipientDid !== tx.recipient()) {
              throw failure("Forbidden", 403);
            }

            validLease(tx, params, now);
          });
          const pair = new WebSocketPair();
          const [server, client] = Object.values(pair);

          if (!server || !client) {
            return yield* Effect.fail(failure("MailboxUnavailable", 503));
          }

          this.ctx.acceptWebSocket(server);
          server.serializeAttachment({
            ...params,
            deadline: now + 5000,
            state: "awaitingAuth",
          });

          const alarm = yield* Effect.promise(() =>
            this.ctx.storage.getAlarm()
          );

          if (alarm === null || alarm > now + 5000) {
            yield* Effect.promise(() => this.ctx.storage.setAlarm(now + 5000));
          }

          return new Response(null, { status: 101, webSocket: client });
        }.bind(this)
      ).pipe(
        Effect.provide(this.store),
        Effect.catchTag("XrpcFailure", (error) =>
          Effect.succeed(errorResponse(error))
        )
      )
    );
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const attachment = Schema.decodeUnknownSync(SocketAttachment)(
      socket.deserializeAttachment()
    );

    if (attachment.state !== "awaitingAuth") {
      Mailbox.closeSocket(socket, socketCodes.auth, "Unexpected frame");

      return Promise.resolve();
    }

    if (Effect.runSync(Clock.currentTimeMillis) >= attachment.deadline) {
      Mailbox.closeSocket(
        socket,
        socketCodes.timeout,
        "Authentication timeout"
      );

      return Promise.resolve();
    }

    socket.serializeAttachment(socketStep(attachment, "authenticate"));

    return Effect.runPromise(
      Effect.gen(
        function* socketAuth(this: Mailbox) {
          const auth = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                $type: Schema.Literal(
                  "sh.mschf.ratking.mailbox.subscribe#auth"
                ),
                token: Subscribe.Auth.schema.fields.token,
              })
            )
          )(message);

          const issuer = yield* authenticate({
            audience: `${this.env.SERVICE_DID}#mailbox`,
            authorization: `Bearer ${auth.token}`,
            now: yield* Clock.currentTimeMillis,
            nsid: Subscribe.Method.nsid,
          }).pipe(
            Effect.provide(
              Layer.merge(documentsLayer(this.env), replayLayer(this.env))
            )
          );

          if (issuer !== attachment.recipientDid) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          const store = yield* MailboxStore;
          const now = yield* Clock.currentTimeMillis;
          yield* store.transaction((tx) => {
            validLease(tx, attachment, now);

            const current = Schema.decodeUnknownSync(SocketAttachment)(
              socket.deserializeAttachment()
            );

            if (current.state !== "authenticating") {
              return;
            }

            if (now >= current.deadline) {
              Mailbox.closeSocket(
                socket,
                socketCodes.timeout,
                "Authentication timeout"
              );

              return;
            }

            socket.serializeAttachment(socketStep(current, "accept"));
            socket.send(
              JSON.stringify({
                $type: "sh.mschf.ratking.mailbox.subscribe#notice",
                seq: tx.watermark(),
              })
            );
          });

          return yield* Effect.void;
        }.bind(this)
      ).pipe(
        Effect.provide(this.store),
        Effect.catchTag("SchemaError", () =>
          Effect.sync(() => {
            Mailbox.closeSocket(
              socket,
              socketCodes.auth,
              "Authentication refused"
            );
          })
        ),
        Effect.catchTag("XrpcFailure", (error) =>
          Effect.sync(() => {
            const code = Schema.is(
              Schema.Struct({ error: Schema.Literal("LeaseMismatch") })
            )(error)
              ? socketCodes.stale
              : socketCodes.auth;

            Mailbox.closeSocket(socket, code, "Authentication refused");
          })
        )
      )
    );
  }

  override webSocketClose(socket: WebSocket) {
    const attachment = Schema.decodeUnknownSync(SocketAttachment)(
      socket.deserializeAttachment()
    );

    socket.serializeAttachment(socketStep(attachment, "close"));

    return this.alarm();
  }

  override webSocketError(socket: WebSocket) {
    Mailbox.closeSocket(socket, socketCodes.auth, "Socket error");

    return this.alarm();
  }

  override alarm() {
    let deadline = Number.POSITIVE_INFINITY;

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = Schema.decodeUnknownSync(SocketAttachment)(
        socket.deserializeAttachment()
      );

      if (
        attachment.state === "awaitingAuth" ||
        attachment.state === "authenticating"
      ) {
        if (Effect.runSync(Clock.currentTimeMillis) >= attachment.deadline) {
          Mailbox.closeSocket(
            socket,
            socketCodes.timeout,
            "Authentication timeout"
          );
        } else {
          deadline = Math.min(deadline, attachment.deadline);
        }
      }
    }

    return Number.isFinite(deadline)
      ? this.ctx.storage.setAlarm(deadline)
      : Promise.resolve();
  }
}

const scheduleWake = (
  context: Pick<ExecutionContext, "waitUntil">,
  wake: Effect.Effect<void, XrpcFailure>
) => {
  context.waitUntil(Effect.runPromise(wake.pipe(Effect.ignore)));
};

const wakeHosted = Effect.fn("Mailbox.wakeHosted")(function* wakeHosted(
  env: Bindings,
  recipient: string,
  body: string,
  context?: Pick<ExecutionContext, "waitUntil">
) {
  if (env.AGENT === undefined) {
    return yield* Effect.void;
  }

  const hosts = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(Schema.String))
  )(env.HOSTED_AGENTS ?? "[]");

  if (!hosts.includes(recipient)) {
    return yield* Effect.void;
  }

  const admitted = yield* Schema.decodeEffect(
    Schema.fromJsonString(Send.Output)
  )(body);

  const agents = env.AGENT;

  const wake = Effect.gen(function* wakeAgent() {
    const outcome = yield* Effect.tryPromise({
      catch: () => failure("MailboxUnavailable", 503),
      try: () => agents.getByName(recipient).wake(),
    }).pipe(
      Effect.match({
        onFailure: () => "unavailable" as const,
        onSuccess: () => "accepted" as const,
      })
    );

    yield* Effect.tryPromise({
      catch: () => failure("MailboxUnavailable", 503),
      try: () =>
        Promise.resolve(
          env.MAILBOX.getByName(recipient).recordWake(
            admitted.receipt.message.senderDid,
            admitted.receipt.message.messageId,
            outcome
          )
        ),
    });
  });

  if (context === undefined) {
    yield* wake;
  } else {
    scheduleWake(context, wake);
  }

  return yield* Effect.void;
});

export const fetchRequest = (
  request: Request,
  env: Bindings,
  context?: Pick<ExecutionContext, "waitUntil">
) =>
  Effect.gen(function* handleRequest() {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/rat-king/version") {
      return Response.json(bundle);
    }

    const nsid = url.pathname.slice("/xrpc/".length);

    if (url.pathname === Subscribe.Method.path) {
      const params = yield* Subscribe.decodeParams([
        ...url.searchParams.entries(),
      ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

      return yield* Effect.tryPromise({
        catch: () => failure("MailboxUnavailable", 503),
        try: () => env.MAILBOX.getByName(params.recipientDid).fetch(request),
      });
    }

    const procedures = [
      Send.Method,
      Ack.Method,
      Deliver.Method,
      Acquire.Method,
      Renew.Method,
      Release.Method,
      PutDocument.Method,
    ];

    if (
      !url.pathname.startsWith("/xrpc/") ||
      ![...procedures, List.Method, Resolve.Method].some(
        (method) => method.nsid === nsid
      )
    ) {
      return Response.json({ error: "InvalidRequest" }, { status: 404 });
    }

    const issuer = yield* authenticate({
      audience: `${env.SERVICE_DID}#mailbox`,
      authorization: request.headers.get("authorization"),
      now: yield* Clock.currentTimeMillis,
      nsid,
    }).pipe(Effect.provide(Layer.merge(documentsLayer(env), replayLayer(env))));

    let recipient: string;
    let transport: XrpcRequest;

    if (nsid === List.Method.nsid || nsid === Resolve.Method.nsid) {
      if (request.method !== "GET") {
        return yield* Effect.fail(failure("InvalidRequest"));
      }

      if (nsid === List.Method.nsid) {
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
        const params = yield* Resolve.decodeParams([
          ...url.searchParams.entries(),
        ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

        recipient = params.did;
        transport = {
          input: undefined,
          method: "GET",
          nsid,
          params: yield* Schema.encodeEffect(Resolve.Params)(params),
        };
      }
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

      const destination = Effect.gen(function* destination() {
        switch (nsid) {
          case Send.Method.nsid: {
            return (yield* Schema.decodeUnknownEffect(Send.Input)(input))
              .envelope.aad.recipientDid;
          }

          case Ack.Method.nsid: {
            return (yield* Schema.decodeUnknownEffect(Ack.Input)(input))
              .recipientDid;
          }

          case Deliver.Method.nsid: {
            return (yield* Schema.decodeUnknownEffect(Deliver.Input)(input))
              .recipientDid;
          }

          case Acquire.Method.nsid: {
            return (yield* Schema.decodeUnknownEffect(Acquire.Input)(input))
              .did;
          }

          case Renew.Method.nsid: {
            return (yield* Schema.decodeUnknownEffect(Renew.Input)(input)).did;
          }

          case Release.Method.nsid: {
            return (yield* Schema.decodeUnknownEffect(Release.Input)(input))
              .did;
          }

          case PutDocument.Method.nsid: {
            return (yield* Schema.decodeUnknownEffect(PutDocument.Input)(input))
              .document.id;
          }

          default: {
            return yield* Effect.fail(failure("InvalidRequest"));
          }
        }
      });

      recipient = yield* destination.pipe(
        Effect.mapError(() => failure("InvalidRequest"))
      );
      transport = {
        input: yield* Schema.decodeUnknownEffect(
          Schema.toEncoded(Runtime.Data)
        )(input),
        method: "POST",
        nsid,
        params: undefined,
      };
    }

    const response = yield* Effect.tryPromise({
      catch: () => failure("MailboxUnavailable", 503),
      try: () => env.MAILBOX.getByName(recipient).route(transport, issuer),
    });

    if (nsid === Send.Method.nsid && response.status === 200) {
      yield* wakeHosted(env, recipient, response.body, context).pipe(
        Effect.ignore
      );
    }

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
  fetch: (request: Request, env: Bindings, context?: ExecutionContext) =>
    Effect.runPromise(fetchRequest(request, env, context)),
};

export { AuthTokens } from "./auth-tokens.ts";
