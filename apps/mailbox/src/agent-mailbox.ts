import { HarnessFailure } from "@rat-king/agent-runtime";
import { AgentMailbox } from "@rat-king/agent-runtime/mailbox-loop";
import type { LoopMailbox } from "@rat-king/agent-runtime/mailbox-loop";
// @effect-diagnostics asyncFunction:off -- Local response.json Promise interface.
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Local DO RPC and Request parsing adapters. */
import { EnvelopeFailure } from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Send from "@rat-king/lexicon/mailbox.send";
import { Clock, Effect, Schema } from "effect";

import {
  base64url,
  DidResolver,
  Documents,
  serviceToken,
  staticResolver,
} from "./auth.ts";
import type { Bindings } from "./bindings.ts";
import { tid } from "./tid.ts";
import { fetchRequest } from "./worker.ts";

export const resolveAgentKey =
  (env: Bindings) =>
  (did: string, keyId: string, purpose: "authentication" | "keyAgreement") =>
    Effect.gen(function* resolveKey() {
      const resolver = yield* DidResolver;

      return yield* resolver.resolve(did, keyId, purpose);
    }).pipe(
      Effect.provide(
        staticResolver(
          Schema.decodeUnknownSync(Documents)(JSON.parse(env.DID_DOCUMENTS))
        )
      ),
      Effect.mapError(
        () => new EnvelopeFailure({ reason: "Unauthorized agent envelope key" })
      )
    );

interface LocalListParams {
  recipientDid: string;
  cursor?: string;
}

const rpc = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () =>
      new HarnessFailure({ operation, reason: "Local mailbox RPC failed" }),
    try: run,
  });

export const agentMailbox = (env: Bindings, did: string, signing: CryptoKey) =>
  Effect.gen(function* mailboxAdapter() {
    const stub = env.MAILBOX.getByName(did);

    const leaseId = tid(
      yield* Clock.currentTimeMillis,
      crypto.getRandomValues(new Uint16Array(1))[0] ?? 0
    );

    let lease = yield* Effect.acquireRelease(
      rpc("lease.acquire", () => stub.acquireLease(leaseId, 60_000)),
      (owned) =>
        rpc("lease.release", () =>
          stub.releaseLease(owned.leaseId, owned.generation)
        ).pipe(Effect.orDie)
    );

    const renew = () =>
      rpc("lease.renew", () =>
        stub.renewLease(lease.leaseId, lease.generation, 60_000)
      ).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            lease = next;
          })
        )
      );

    const xrpc = Effect.fn("AgentMailbox.xrpc")(
      function* xrpc(
        nsid: string,
        input?: typeof Send.Input.Encoded | typeof Ack.Input.Encoded,
        params?: LocalListParams
      ) {
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

        const token = yield* serviceToken(
          {
            aud: `${env.SERVICE_DID}#mailbox`,
            exp: now + 60,
            iat: now,
            iss: did,
            jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
            lxm: nsid,
          },
          signing
        );

        const url = new URL(`https://mailbox.example.invalid/xrpc/${nsid}`);

        for (const [key, value] of Object.entries(params ?? {})) {
          url.searchParams.set(key, String(value));
        }

        const init: RequestInit = {
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: input === undefined ? "GET" : "POST",
        };

        if (input !== undefined) {
          init.body = JSON.stringify(input);
        }

        const response = yield* fetchRequest(new Request(url, init), env);

        if (!response.ok) {
          return yield* new HarnessFailure({
            operation: `${nsid}:${response.status}`,
            reason: `Local XRPC refused: ${response.status}`,
          });
        }

        return yield* rpc(nsid, async () => {
          const data: unknown = await response.json();

          return data;
        });
      },
      Effect.mapError((error) =>
        Schema.is(HarnessFailure)(error)
          ? error
          : new HarnessFailure({
              operation: "xrpc",
              reason: "Authenticated local XRPC failed",
            })
      )
    );

    return AgentMailbox.of({
      ack: Effect.fn("AgentMailbox.ack")(
        function* ack(message) {
          yield* renew();

          const input = yield* Schema.decodeUnknownEffect(
            Schema.toType(Ack.Input)
          )({
            generation: lease.generation,
            leaseId: lease.leaseId,
            message,
            recipientDid: did,
          });

          yield* xrpc(
            Ack.Method.nsid,
            yield* Schema.encodeEffect(Ack.Input)(input)
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ack.Output)));
        },
        Effect.mapError((error) =>
          Schema.is(HarnessFailure)(error)
            ? error
            : new HarnessFailure({
                operation: "ack",
                reason: "Cannot acknowledge agent input",
              })
        )
      ),
      fail: Effect.fn("AgentMailbox.fail")(function* fail(message, reason) {
        yield* rpc("fail", () =>
          stub.settle(message.senderDid, message.messageId, "fail", reason)
        );
      }),
      inject: Effect.fn("AgentMailbox.inject")(function* inject(message) {
        yield* renew();
        yield* rpc("inject", () =>
          stub.inject(
            message.senderDid,
            message.messageId,
            lease.leaseId,
            lease.generation
          )
        );
      }),
      pending: Effect.fn("AgentMailbox.pending")(
        function* pending() {
          const messages = new Map<
            string,
            { envelope: Defs.EncryptedEnvelopeValue; state: string }
          >();

          let cursor: string | undefined;

          do {
            const params: LocalListParams = { recipientDid: did };

            if (cursor !== undefined) {
              params.cursor = cursor;
            }

            const page = yield* xrpc(List.Method.nsid, undefined, params).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(List.Output))
            );

            for (const raw of page.events) {
              if (
                raw.$type !== "sh.mschf.ratking.defs#messageEvent" &&
                raw.$type !== "sh.mschf.ratking.defs#receiptEvent"
              ) {
                continue;
              }

              const event = yield* Schema.decodeUnknownEffect(
                Schema.toType(
                  Schema.Union([Defs.MessageEvent, Defs.ReceiptEvent])
                )
              )(raw);

              const key = `${event.receipt.message.senderDid}/${event.receipt.message.messageId}`;

              if (Schema.is(Defs.MessageEvent)(event)) {
                messages.set(key, {
                  envelope: event.envelope,
                  state: event.receipt.state,
                });
              } else {
                const item = messages.get(key);

                if (item !== undefined) {
                  item.state = event.receipt.state;
                }
              }
            }

            ({ cursor } = page);
          } while (cursor !== undefined);

          return [...messages.values()].flatMap((item) =>
            ["accepted", "queued", "delivered"].includes(item.state)
              ? [item.envelope]
              : []
          );
        },
        Effect.mapError(
          () =>
            new HarnessFailure({
              operation: "list",
              reason: "Cannot read mailbox snapshot",
            })
        )
      ),
      send: Effect.fn("AgentMailbox.send")(
        function* send(envelope) {
          const decoded = Send.Input.make({ envelope });
          yield* xrpc(
            Send.Method.nsid,
            yield* Schema.encodeEffect(Send.Input)(decoded)
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Send.Output)));
        },
        Effect.mapError(
          () =>
            new HarnessFailure({
              operation: "send",
              reason: "Cannot admit agent reply",
            })
        )
      ),
    } satisfies LoopMailbox);
  });
