import { EnvelopeFailure } from "@rat-king/envelope/failure";
import { openPlaintext } from "@rat-king/envelope/signed";
import * as PutDocument from "@rat-king/lexicon/admin.putDidDocument";
import * as AttentionStatus from "@rat-king/lexicon/attention.status";
import * as Defs from "@rat-king/lexicon/defs";
import * as DeskInbox from "@rat-king/lexicon/desk.inbox";
import * as DeskPending from "@rat-king/lexicon/desk.pending";
import * as DeskReplyFor from "@rat-king/lexicon/desk.replyFor";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import { MailboxServer, serverLayer } from "@rat-king/lexicon/mailbox-server";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as Deliver from "@rat-king/lexicon/mailbox.deliver";
import * as Peer from "@rat-king/lexicon/mailbox.getPeerDocument";
import * as Presence from "@rat-king/lexicon/mailbox.getPresence";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Traffic from "@rat-king/lexicon/mailbox.listTraffic";
import * as NameHealth from "@rat-king/lexicon/mailbox.nameHealth";
import * as Send from "@rat-king/lexicon/mailbox.send";
import * as Subscribe from "@rat-king/lexicon/mailbox.subscribe";
import * as SubscribeTraffic from "@rat-king/lexicon/mailbox.subscribeTraffic";
import * as Runtime from "@rat-king/lexicon/runtime";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import * as Resolve from "@rat-king/lexicon/runtime.resolveLease";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { DurableObject } from "cloudflare:workers";
import { Cause, Clock, Effect, Layer, Option, Schema } from "effect";

import { defaultStatus } from "../../../packages/mailbox-client/src/attention.ts";
import { PayloadJson } from "../../../packages/mailbox-client/src/payload.ts";
import { AttentionDirectory } from "./attention-directory.ts";
import { attentionMethods, attentionRequest } from "./attention-http.ts";
import { authenticate, authenticateClaims, DidResolver } from "./auth.ts";
import type { Bindings } from "./bindings.ts";
import {
  DelegatedCopy,
  DelegationTransport,
  acceptDelegated,
  flushDelegations,
} from "./delegation.ts";
import { deskMethods } from "./desk.ts";
import {
  documentsJson,
  documentsLayer,
  didAllowlist,
  peerDocument,
} from "./documents.ts";
import { logFailure } from "./failure-log.ts";
import type { FailureScope } from "./failure-log.ts";
import { errorResponse, failure } from "./failure.ts";
import { wakeHosted } from "./hosted-wake.ts";
import { issuerInstance } from "./issuer-object.ts";
import { issuerMethods } from "./issuer.ts";
import { jsonResponse } from "./json-response.ts";
import { validLease } from "./lease.ts";
import {
  Caller,
  mailboxHandlers,
  deliverMessage,
  storeDocument,
  LeaseAuthority,
  leaseLayer,
} from "./mailbox.ts";
import { nameHealthRequest } from "./name-health-http.ts";
import { nameHealth } from "./name-health.ts";
import { replayLayer } from "./replay.ts";
import { isoTime, markRetired, presenceOf, standingOf } from "./retirement.ts";
import { SenderFence } from "./sender-fence.ts";
import { SocketAttachment, socketStep, socketCodes } from "./socket.ts";
import { sqliteStore } from "./sqlite.ts";
import type { Sql } from "./sqlite.ts";
import { MailboxStore, Retirement, storageOperation } from "./store.ts";
import type { LeaseValue, Event } from "./store.ts";
import { TerminalDelivery, terminalLayer } from "./terminal.ts";
import { trafficRequest } from "./traffic-http.ts";
import { trafficSockets } from "./traffic-socket.ts";
import {
  appendTraffic,
  listTraffic,
  pendingTraffic,
  TrafficOutboxEntry,
  trafficDid,
  trafficPermission,
  trafficWatermark,
} from "./traffic-store.ts";

declare const __BUNDLE_VERSION__: string;

declare const __BUNDLE_COMMIT__: string;

export const bundle = {
  commit: __BUNDLE_COMMIT__,
  version: __BUNDLE_VERSION__,
};

const unknownPosition = () => ({});

const RouteResult = Schema.Struct({
  body: Schema.String,
  seq: Schema.optionalKey(Schema.Int),
  status: Schema.Int,
});

const ListPosition = Schema.Struct({ afterSeq: Schema.Int });

const MessagePosition = Schema.Struct({
  message: Schema.Struct({
    messageId: Schema.String,
    senderDid: Schema.String,
  }),
});

const armTraffic = Effect.fn("Traffic.arm")(function* arm(
  ctx: DurableObjectState
) {
  const now = yield* Clock.currentTimeMillis;
  const alarm = yield* Effect.promise(() => ctx.storage.getAlarm());

  if (alarm === null || alarm > now + 1000) {
    yield* Effect.promise(() => ctx.storage.setAlarm(now + 1000));
  }
});

const flushTraffic = Effect.fn("Traffic.flush")(function* flush(
  sql: Sql,
  env: Bindings
) {
  const entries = yield* storageOperation(() => pendingTraffic(sql));

  if (entries.length === 0) {
    return;
  }

  yield* Effect.tryPromise({
    catch: () => failure("MailboxUnavailable", 503),
    try: () =>
      Promise.resolve(
        env.MAILBOX.getByName(trafficDid).recordTraffic(JSON.stringify(entries))
      ),
  });
  yield* storageOperation(() => {
    for (const entry of entries) {
      sql.exec("DELETE FROM traffic_outbox WHERE seq=?", entry.recipientSeq);
    }
  });
});

export class Mailbox extends DurableObject<Bindings> {
  private readonly store;
  private readonly sql;
  private readonly feedSockets;
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const recipient = ctx.id.name;

    if (recipient?.startsWith("did:web:") !== true) {
      throw failure("Forbidden", 403);
    }

    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS wake_attempts (id INTEGER PRIMARY KEY, sender TEXT NOT NULL, tid TEXT NOT NULL, outcome TEXT NOT NULL)"
    );
    this.sql = {
      exec: (query: string, ...values: readonly (string | number)[]) =>
        ctx.storage.sql.exec(query, ...values),
      transaction: <A>(operation: () => A) =>
        ctx.storage.transactionSync(operation),
    };
    this.feedSockets = trafficSockets(
      ctx,
      (token) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            authenticateClaims({
              audience: `${env.SERVICE_DID}#mailbox`,
              authorization: `Bearer ${token}`,
              now,
              nsid: SubscribeTraffic.Method.nsid,
            })
          ),
          Effect.provide(Layer.merge(documentsLayer(env), replayLayer(env))),
          Effect.tap((claims) =>
            storageOperation(() => {
              trafficPermission(
                claims.iss,
                didAllowlist(env.OPERATOR_DIDS),
                didAllowlist(env.OBSERVER_DIDS)
              );
            })
          )
        ),
      () => trafficWatermark(this.sql)
    );
    this.store = sqliteStore(
      this.sql,
      recipient,
      (events, lease) => {
        this.committed(events, lease);
      },
      armTraffic(this.ctx),
      env.DELEGATION === "true"
    );
  }
  recordTraffic(json: string) {
    const entries = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Array(TrafficOutboxEntry).check(Schema.isMaxLength(100))
      )
    )(json);

    if (this.ctx.id.name !== trafficDid) {
      throw failure("Forbidden", 403);
    }

    appendTraffic(this.sql, entries);
    this.feedSockets.broadcast();
  }

  readTraffic(json: string, issuer: string) {
    return Effect.runPromise(
      storageOperation(() => {
        trafficPermission(
          issuer,
          didAllowlist(this.env.OPERATOR_DIDS),
          didAllowlist(this.env.OBSERVER_DIDS)
        );

        const params = Schema.decodeUnknownSync(
          Schema.fromJsonString(Traffic.Params)
        )(json);

        return {
          body: JSON.stringify(
            listTraffic(this.sql, params, this.env.DELEGATION === "true")
          ),
          status: 200,
        };
      }).pipe(
        Effect.catchTag("XrpcFailure", (error) =>
          Effect.succeed({
            body: JSON.stringify({ error: error.error }),
            status: error.status,
          })
        )
      )
    );
  }

  readNameHealth(json: string, issuer: string) {
    const { ctx, sql, env } = this;

    return Effect.runPromise(
      Effect.gen(function* readHealth() {
        const params = yield* Schema.decodeEffect(
          Schema.fromJsonString(NameHealth.Params)
        )(json);

        if (params.recipientDid !== ctx.id.name) {
          return yield* failure("Forbidden", 403);
        }

        const result = yield* nameHealth(
          sql,
          params,
          issuer,
          didAllowlist(env.OPERATOR_DIDS)
        );

        return {
          body: JSON.stringify(
            yield* Schema.encodeEffect(NameHealth.Output)(result)
          ),
          status: 200,
        };
      }).pipe(
        Effect.match({
          onFailure: (error) => ({
            body: JSON.stringify({
              error: Schema.is(XrpcFailure)(error)
                ? error.error
                : "MailboxUnavailable",
            }),
            status: Schema.is(XrpcFailure)(error) ? error.status : 503,
          }),
          onSuccess: (result) => result,
        })
      )
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

  publicAttentionStatus() {
    return Effect.runPromise(
      Effect.gen(function* publicAttentionStatus() {
        const store = yield* MailboxStore;

        return yield* store.transaction((tx) =>
          JSON.stringify(tx.attentionStatus() ?? defaultStatus())
        );
      }).pipe(Effect.provide(this.store))
    );
  }

  private hasPendingDelegations() {
    return (
      this.env.DELEGATION === "true" &&
      [
        ...this.sql.exec(
          "SELECT 1 FROM messages WHERE json_extract(value,'$.delegationPending') IS NOT NULL LIMIT 1"
        ),
      ].length > 0
    );
  }

  private delegationTransport() {
    const { env } = this;

    return Layer.succeed(DelegationTransport, {
      append: (did, copy) =>
        Schema.encodeEffect(Schema.fromJsonString(DelegatedCopy))(copy).pipe(
          Effect.mapError(() => failure("InvalidRequest")),
          Effect.flatMap((json) =>
            Effect.tryPromise({
              catch: () => failure("MailboxUnavailable", 503),
              try: () => env.MAILBOX.getByName(did).appendDelegated(json),
            })
          )
        ),
    });
  }

  appendDelegated(json: string) {
    const { env, ctx } = this;

    return Effect.runPromise(
      Effect.gen(function* appendDelegated() {
        if (env.DELEGATION !== "true" || env.ISSUER === undefined) {
          return yield* failure("Forbidden", 403);
        }

        const copy = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(DelegatedCopy)
        )(json);

        const resolver = yield* DidResolver;

        const signed = yield* openPlaintext(copy.envelope, (did, key) =>
          resolver.resolve(did, key, "authentication").pipe(
            Effect.mapError(
              () =>
                new EnvelopeFailure({
                  reason: "Unauthorized sender signing key",
                })
            )
          )
        );

        const payload = yield* Schema.decodeUnknownEffect(PayloadJson)(
          new TextDecoder().decode(signed.body)
        );

        if (payload.to !== copy.delegatedFor) {
          return yield* failure("Forbidden", 403);
        }

        const issuers = env.ISSUER;

        const deskDid = yield* Effect.tryPromise({
          catch: () => failure("MailboxUnavailable", 503),
          try: () =>
            issuers.getByName(issuerInstance).lookupName(copy.delegatedFor),
        });

        if (deskDid !== copy.envelope.aad.recipientDid) {
          return yield* failure("Forbidden", 403);
        }

        yield* acceptDelegated(copy);
        const store = yield* MailboxStore;

        const receipt = yield* store.transaction(
          (tx) => tx.get(copy.envelope.aad.senderDid, copy.copyId)?.admission
        );

        if (receipt !== undefined) {
          yield* wakeHosted(
            env,
            copy.delegateDid,
            JSON.stringify({ receipt }),
            ctx
          );
        }

        return yield* Effect.void;
      }).pipe(Effect.provide(Layer.merge(this.store, documentsLayer(env))))
    );
  }

  route(request: XrpcRequest, issuer: string) {
    const { env } = this;

    const layer = mailboxHandlers({
      delegation: env.DELEGATION === "true",
      operators: didAllowlist(this.env.OPERATOR_DIDS),
      resolvers: didAllowlist(this.env.LEASE_RESOLVERS),
      staticDocuments: Schema.decodeSync(
        Schema.fromJsonString(Schema.Array(Defs.DidDocument))
      )(documentsJson(this.env)),
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
      Layer.provide(
        Layer.succeed(AttentionDirectory, {
          resolve: Effect.fn("AttentionDirectory.resolve")(function* resolve(
            name: string
          ) {
            const issuers = env.ISSUER;

            if (issuers === undefined) {
              return yield* Effect.fail(failure("MailboxUnavailable", 503));
            }

            const did = yield* Effect.tryPromise({
              catch: () => failure("MailboxUnavailable", 503),
              try: () => issuers.getByName(issuerInstance).lookupName(name),
            });

            return Option.fromUndefinedOr(did);
          }),
          status: Effect.fn("AttentionDirectory.status")(function* status(
            did: string
          ) {
            const value = yield* Effect.tryPromise({
              catch: () => failure("MailboxUnavailable", 503),
              try: () => env.MAILBOX.getByName(did).publicAttentionStatus(),
            });

            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(AttentionStatus.Main)
            )(value).pipe(
              Effect.mapError(() => failure("MailboxUnavailable", 503))
            );
          }),
        })
      ),
      Layer.provide(this.delegationTransport()),
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
        Effect.provide(serverLayer.pipe(Layer.provide(layer))),
        Effect.flatMap((response) =>
          response.status < 400
            ? Effect.succeed(response)
            : this.failurePosition(request).pipe(
                Effect.map((position) => ({ ...response, ...position }))
              )
        )
      )
    );
  }

  private failurePosition(
    request: XrpcRequest
  ): Effect.Effect<{ readonly seq?: number }> {
    if (request.nsid === List.Method.nsid) {
      return Schema.decodeUnknownEffect(ListPosition)(request.params).pipe(
        Effect.map(({ afterSeq }) => ({ seq: afterSeq })),
        Effect.orElseSucceed(unknownPosition)
      );
    }

    if (
      request.nsid !== Deliver.Method.nsid &&
      request.nsid !== Ack.Method.nsid
    ) {
      return Effect.succeed({});
    }

    return Schema.decodeUnknownEffect(MessagePosition)(request.input).pipe(
      Effect.flatMap(({ message }) =>
        MailboxStore.use((store) =>
          store.transaction((tx) => {
            const stored = tx.get(message.senderDid, message.messageId);

            return stored === undefined ? {} : { seq: stored.admission.seq };
          })
        )
      ),
      Effect.provide(this.store),
      Effect.orElseSucceed(unknownPosition)
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
  storeDocument(json: string) {
    const document = Schema.decodeSync(Schema.fromJsonString(Defs.DidDocument))(
      json
    );

    const staticDocuments = Schema.decodeSync(
      Schema.fromJsonString(Schema.Array(Defs.DidDocument))
    )(documentsJson(this.env));

    return Effect.runPromise(
      MailboxStore.use((store) =>
        store.transaction((tx) => {
          storeDocument(tx, staticDocuments, document);

          return "stored";
        })
      ).pipe(
        Effect.catchTag("XrpcFailure", (error) => Effect.succeed(error.error)),
        Effect.provide(this.store)
      )
    );
  }
  presence() {
    return Effect.runPromise(
      Effect.gen(function* presence() {
        const store = yield* MailboxStore;
        const now = yield* Clock.currentTimeMillis;

        return yield* store.transaction((tx) => presenceOf(tx.lease(), now));
      }).pipe(Effect.provide(this.store))
    );
  }
  retire(json: string) {
    const retirement = Schema.decodeSync(Schema.fromJsonString(Retirement))(
      json
    );

    const staticDocuments = Schema.decodeSync(
      Schema.fromJsonString(Schema.Array(Defs.DidDocument))
    )(documentsJson(this.env));

    return Effect.runPromise(
      MailboxStore.use((store) =>
        store.transaction((tx) => {
          markRetired(tx, staticDocuments, retirement);

          return "retired";
        })
      ).pipe(
        Effect.catchTag("XrpcFailure", (error) => Effect.succeed(error.error)),
        Effect.provide(this.store)
      )
    );
  }
  unretire() {
    return Effect.runPromise(
      MailboxStore.use((store) =>
        store.transaction((tx) => {
          const cleared = tx.retirement() !== undefined;
          tx.setRetirement(undefined);

          return cleared;
        })
      ).pipe(Effect.provide(this.store))
    );
  }
  retirement() {
    return Effect.runPromise(
      MailboxStore.use((store) =>
        store.transaction((tx) => {
          const current = tx.retirement();

          return current === undefined
            ? undefined
            : Schema.encodeSync(Schema.fromJsonString(Retirement))(current);
        })
      ).pipe(Effect.provide(this.store))
    );
  }
  standing() {
    const staticDocuments = Schema.decodeSync(
      Schema.fromJsonString(Schema.Array(Defs.DidDocument))
    )(documentsJson(this.env));

    return Effect.runPromise(
      MailboxStore.use((store) =>
        store.transaction((tx) => {
          const { exists, retirement } = standingOf(tx, staticDocuments);

          return {
            exists,
            retirement:
              retirement === undefined
                ? undefined
                : Schema.encodeSync(Schema.fromJsonString(Retirement))(
                    retirement
                  ),
          };
        })
      ).pipe(Effect.provide(this.store))
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
    if (events.length > 0 && this.hasPendingDelegations()) {
      this.ctx.waitUntil(
        Effect.runPromise(
          flushDelegations.pipe(
            Effect.provide(Layer.merge(this.store, this.delegationTransport())),
            Effect.tapError(() =>
              Effect.logWarning(
                "Delegate copy pending; durable outbox will retry"
              )
            ),
            Effect.ignore
          )
        )
      );
    }

    if (events.length > 0) {
      this.ctx.waitUntil(
        Effect.runPromise(
          flushTraffic(this.sql, this.env).pipe(
            Effect.tapError(() =>
              Effect.logWarning(
                "Traffic journal unavailable; durable outbox will retry"
              )
            ),
            Effect.ignore
          )
        )
      );
    }

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
    if (this.ctx.id.name === trafficDid) {
      return this.feedSockets.fetch(request);
    }

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
    if (this.ctx.id.name === trafficDid) {
      return this.feedSockets.message(socket, message);
    }

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

          if (issuer !== attachment.recipientDid || issuer === trafficDid) {
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
    if (this.ctx.id.name === trafficDid) {
      this.feedSockets.close(socket);

      return this.feedSockets.alarm();
    }

    const attachment = Schema.decodeUnknownSync(SocketAttachment)(
      socket.deserializeAttachment()
    );

    socket.serializeAttachment(socketStep(attachment, "close"));

    return this.alarm();
  }

  override webSocketError(socket: WebSocket) {
    if (this.ctx.id.name === trafficDid) {
      this.feedSockets.close(socket);

      return this.feedSockets.alarm();
    }

    Mailbox.closeSocket(socket, socketCodes.auth, "Socket error");

    return this.alarm();
  }

  override alarm() {
    return Effect.runPromise(
      Effect.promise(() => this.runAlarm()).pipe(
        Effect.tapCause((cause) =>
          Effect.logError("Mailbox alarm failed", Cause.pretty(cause))
        )
      )
    );
  }

  private runAlarm() {
    if (this.ctx.id.name === trafficDid) {
      return this.feedSockets.alarm();
    }

    return Effect.runPromise(
      flushTraffic(this.sql, this.env).pipe(
        Effect.andThen(
          this.hasPendingDelegations()
            ? flushDelegations.pipe(
                Effect.provide(
                  Layer.merge(this.store, this.delegationTransport())
                )
              )
            : Effect.void
        ),
        Effect.tapError(() => Effect.logWarning("Traffic retry pending")),
        Effect.ignore,
        Effect.flatMap(() => Effect.promise(() => this.mailboxAlarm()))
      )
    );
  }

  private mailboxAlarm() {
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

    if (pendingTraffic(this.sql).length > 0 || this.hasPendingDelegations()) {
      deadline = Math.min(
        deadline,
        Effect.runSync(Clock.currentTimeMillis) + 1000
      );
    }

    return Number.isFinite(deadline)
      ? this.ctx.storage.setAlarm(deadline)
      : Promise.resolve();
  }
}

const methods = new Set<string>(
  [
    Send.Method,
    Ack.Method,
    Deliver.Method,
    Acquire.Method,
    Renew.Method,
    Release.Method,
    PutDocument.Method,
    List.Method,
    Traffic.Method,
    NameHealth.Method,
    Resolve.Method,
    Peer.Method,
    Presence.Method,
    Subscribe.Method,
    SubscribeTraffic.Method,
    ...attentionMethods,
    ...issuerMethods,
    ...deskMethods,
  ].map((method) => method.nsid)
);

const issuerRequest = Effect.fn("Issuer.request")(function* issuerRequest(
  request: Request,
  env: Bindings,
  nsid: string,
  caller: string
) {
  const issuers = env.ISSUER;

  if (issuers === undefined) {
    return yield* Effect.fail(failure("MailboxUnavailable", 503));
  }

  let transport: XrpcRequest;

  if (nsid === ListNames.Method.nsid || nsid === ListRetired.Method.nsid) {
    if (request.method !== "GET") {
      return yield* Effect.fail(failure("InvalidRequest"));
    }

    const entries = [...new URL(request.url).searchParams.entries()];

    const params = yield* (
      nsid === ListNames.Method.nsid
        ? ListNames.decodeParams(entries).pipe(
            Effect.flatMap(Schema.encodeEffect(ListNames.Params))
          )
        : ListRetired.decodeParams(entries).pipe(
            Effect.flatMap(Schema.encodeEffect(ListRetired.Params))
          )
    ).pipe(Effect.mapError(() => failure("InvalidRequest")));

    transport = { input: undefined, method: "GET", nsid, params };
  } else {
    if (
      request.method !== "POST" ||
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    ) {
      return yield* Effect.fail(failure("InvalidRequest"));
    }

    const input = yield* Effect.tryPromise({
      catch: () => failure("InvalidRequest"),
      try: () => request.json(),
    });

    transport = {
      input: yield* Schema.decodeUnknownEffect(Schema.toEncoded(Runtime.Data))(
        input
      ).pipe(Effect.mapError(() => failure("InvalidRequest"))),
      method: "POST",
      nsid,
      params: undefined,
    };
  }

  const response = yield* Effect.tryPromise({
    catch: () => failure("MailboxUnavailable", 503),
    try: () => issuers.getByName(issuerInstance).route(transport, caller),
  });

  return jsonResponse(response.body, response.status);
});

const deskQuery = (
  nsid: string,
  entries: readonly (readonly [string, string])[]
) => {
  switch (nsid) {
    case DeskInbox.Method.nsid: {
      return DeskInbox.decodeParams(entries).pipe(
        Effect.flatMap((params) =>
          Schema.encodeEffect(DeskInbox.Params)(params).pipe(
            Effect.map((encoded) => ({ desk: params.desk, params: encoded }))
          )
        )
      );
    }

    case DeskPending.Method.nsid: {
      return DeskPending.decodeParams(entries).pipe(
        Effect.flatMap((params) =>
          Schema.encodeEffect(DeskPending.Params)(params).pipe(
            Effect.map((encoded) => ({ desk: params.desk, params: encoded }))
          )
        )
      );
    }

    default: {
      return DeskReplyFor.decodeParams(entries).pipe(
        Effect.flatMap((params) =>
          Schema.encodeEffect(DeskReplyFor.Params)(params).pipe(
            Effect.map((encoded) => ({ desk: params.desk, params: encoded }))
          )
        )
      );
    }
  }
};

const deskRequest = Effect.fn("Desk.request")(function* deskRequest(
  request: Request,
  env: Bindings,
  nsid: string,
  caller: string,
  scope: FailureScope
) {
  const desks = env.DESK;

  if (desks === undefined) {
    return yield* Effect.fail(failure("MailboxUnavailable", 503));
  }

  const query = deskMethods.some(
    (method) => method.nsid === nsid && method.method === "GET"
  );

  let desk: string;
  let transport: XrpcRequest;

  if (query) {
    if (request.method !== "GET") {
      return yield* Effect.fail(failure("InvalidRequest"));
    }

    const decoded = yield* deskQuery(nsid, [
      ...new URL(request.url).searchParams.entries(),
    ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

    ({ desk } = decoded);
    transport = {
      input: undefined,
      method: "GET",
      nsid,
      params: decoded.params,
    };
  } else {
    if (
      request.method !== "POST" ||
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    ) {
      return yield* Effect.fail(failure("InvalidRequest"));
    }

    const input = yield* Effect.tryPromise({
      catch: () => failure("InvalidRequest"),
      try: () => request.json(),
    });

    ({ desk } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ desk: Schema.String })
    )(input).pipe(Effect.mapError(() => failure("InvalidRequest"))));
    transport = {
      input: yield* Schema.decodeUnknownEffect(Schema.toEncoded(Runtime.Data))(
        input
      ).pipe(Effect.mapError(() => failure("InvalidRequest"))),
      method: "POST",
      nsid,
      params: undefined,
    };
  }

  if (desk === trafficDid || !desk.startsWith("did:web:")) {
    return yield* Effect.fail(failure("Forbidden", 403));
  }

  scope.recipient = desk;

  const response = yield* Effect.tryPromise({
    catch: () => failure("MailboxUnavailable", 503),
    try: () => desks.getByName(desk).route(transport, caller),
  });

  return jsonResponse(response.body, response.status);
});

const presenceRequest = Effect.fn("Mailbox.presence")(function* presenceRequest(
  request: Request,
  env: Bindings,
  scope: FailureScope
) {
  if (request.method !== "GET") {
    return yield* Effect.fail(failure("InvalidRequest"));
  }

  const params = yield* Presence.decodeParams([
    ...new URL(request.url).searchParams.entries(),
  ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

  if (params.did === trafficDid) {
    return yield* Effect.fail(failure("Forbidden", 403));
  }

  scope.recipient = params.did;

  const presence = yield* Effect.tryPromise({
    catch: () => failure("MailboxUnavailable", 503),
    try: () => env.MAILBOX.getByName(params.did).presence(),
  });

  const encoded = { did: params.did, held: presence.held };

  if (presence.renders !== undefined) {
    Object.assign(encoded, { renders: presence.renders });
  }

  if (presence.lastHeldAt !== undefined) {
    Object.assign(encoded, { lastHeldAt: isoTime(presence.lastHeldAt) });
  }

  const output = yield* Schema.decodeUnknownEffect(Presence.Output)(
    encoded
  ).pipe(Effect.mapError(() => failure("MailboxUnavailable", 503)));

  return Response.json(yield* Schema.encodeEffect(Presence.Output)(output));
});

const serviceRequest = (
  request: Request,
  env: Bindings,
  nsid: string,
  issuer: string,
  scope: FailureScope
) => {
  if (nsid === NameHealth.Method.nsid) {
    return nameHealthRequest(request, env, issuer);
  }

  if (attentionMethods.some((method) => method.nsid === nsid)) {
    return attentionRequest(request, env, nsid, issuer, scope);
  }

  if (issuerMethods.some((method) => method.nsid === nsid)) {
    return issuerRequest(request, env, nsid, issuer);
  }

  if (deskMethods.some((method) => method.nsid === nsid)) {
    return deskRequest(request, env, nsid, issuer, scope);
  }

  if (nsid === Presence.Method.nsid) {
    return presenceRequest(request, env, scope);
  }

  return trafficRequest({
    issuer,
    nsid,
    observers: didAllowlist(env.OBSERVER_DIDS),
    operators: didAllowlist(env.OPERATOR_DIDS),
    read: (params, caller) =>
      Effect.tryPromise({
        catch: () => failure("MailboxUnavailable", 503),
        try: () =>
          env.MAILBOX.getByName(trafficDid).readTraffic(
            JSON.stringify(params),
            caller
          ),
      }),
    request,
  });
};

const handleRequest = (
  request: Request,
  env: Bindings,
  scope: FailureScope,
  context?: Pick<ExecutionContext, "waitUntil">
) =>
  Effect.gen(function* handle() {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/rat-king/version") {
      return Response.json(bundle);
    }

    const nsid = url.pathname.slice("/xrpc/".length);

    if (url.pathname === SubscribeTraffic.Method.path) {
      return yield* Effect.tryPromise({
        catch: () => failure("MailboxUnavailable", 503),
        try: () => env.MAILBOX.getByName(trafficDid).fetch(request),
      });
    }

    if (url.pathname === Subscribe.Method.path) {
      const params = yield* Subscribe.decodeParams([
        ...url.searchParams.entries(),
      ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

      scope.recipient = params.recipientDid;

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
      ![
        ...procedures,
        List.Method,
        NameHealth.Method,
        Traffic.Method,
        Resolve.Method,
        Peer.Method,
        Presence.Method,
        ...attentionMethods,
        ...issuerMethods,
        ...deskMethods,
      ].some((method) => method.nsid === nsid)
    ) {
      return Response.json({ error: "InvalidRequest" }, { status: 404 });
    }

    const issuer = yield* authenticate({
      audience: `${env.SERVICE_DID}#mailbox`,
      authorization: request.headers.get("authorization"),
      now: yield* Clock.currentTimeMillis,
      nsid,
    }).pipe(Effect.provide(Layer.merge(documentsLayer(env), replayLayer(env))));

    if (nsid === Peer.Method.nsid) {
      if (request.method !== "GET") {
        return yield* Effect.fail(failure("InvalidRequest"));
      }

      const params = yield* Peer.decodeParams([
        ...url.searchParams.entries(),
      ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

      const document = yield* peerDocument(env, issuer, params.did);

      const output = yield* Schema.decodeUnknownEffect(Peer.Output)({
        document,
      }).pipe(Effect.mapError(() => failure("MailboxUnavailable", 503)));

      return Response.json(yield* Schema.encodeEffect(Peer.Output)(output));
    }

    const trafficResponse = yield* serviceRequest(
      request,
      env,
      nsid,
      issuer,
      scope
    );

    if (trafficResponse !== undefined) {
      return trafficResponse;
    }

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

    if (recipient === trafficDid) {
      return yield* Effect.fail(failure("Forbidden", 403));
    }

    scope.recipient = recipient;

    const response = yield* Effect.tryPromise({
      catch: () => failure("MailboxUnavailable", 503),
      try: () => env.MAILBOX.getByName(recipient).route(transport, issuer),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RouteResult)),
      Effect.mapError(() => failure("MailboxUnavailable", 503))
    );

    if (response.seq !== undefined) {
      scope.seq = response.seq;
    }

    if (nsid === Send.Method.nsid && response.status === 200) {
      yield* wakeHosted(env, recipient, response.body, context).pipe(
        Effect.ignore
      );
    }

    return jsonResponse(response.body, response.status);
  });

export const fetchRequest = (
  request: Request,
  env: Bindings,
  context?: Pick<ExecutionContext, "waitUntil">
) => {
  const nsid = new URL(request.url).pathname.slice("/xrpc/".length);
  const scope: FailureScope = { method: methods.has(nsid) ? nsid : "unknown" };

  return handleRequest(request, env, scope, context).pipe(
    Effect.catchTag("XrpcFailure", (error) =>
      Effect.succeed(errorResponse(error))
    ),
    Effect.tap((response) => logFailure(scope, response))
  );
};

export default {
  fetch: (request: Request, env: Bindings, context?: ExecutionContext) =>
    Effect.runPromise(fetchRequest(request, env, context)),
};

export { AuthTokens } from "./auth-tokens.ts";

export { Issuer } from "./issuer-object.ts";

export { Desk } from "./desk-object.ts";
