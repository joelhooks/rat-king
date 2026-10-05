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
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as RuntimeLease from "@rat-king/lexicon/runtime.lease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import { base64url, DidResolver, serviceToken } from "@rat-king/mailbox-client";
import { Clock, DateTime, Effect, Schema } from "effect";

import type { Bindings } from "./bindings.ts";
import { documentsLayer } from "./documents.ts";
import { fetchRequest } from "./worker.ts";

export const resolveAgentKey =
  (env: Bindings) =>
  (did: string, keyId: string, purpose: "authentication" | "keyAgreement") =>
    Effect.gen(function* resolveKey() {
      const resolver = yield* DidResolver;

      return yield* resolver.resolve(did, keyId, purpose);
    }).pipe(
      Effect.provide(documentsLayer(env)),
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

const expiresAt = (now: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now + 60_000));

export const agentMailbox = (env: Bindings, did: string, signing: CryptoKey) =>
  Effect.gen(function* mailboxAdapter() {
    const stub = env.MAILBOX.getByName(did);

    const acquire = yield* Schema.decodeUnknownEffect(Acquire.Input)({
      did,
      expiresAt: expiresAt(yield* Clock.currentTimeMillis),
      harness: {
        $type: "sh.mschf.ratking.runtime.lease#other",
        kind: "hosted",
        sessionId: did,
      },
    });

    let lease = yield* Effect.acquireRelease(
      rpc("lease.acquire", () =>
        stub.acquireLease(JSON.stringify(acquire))
      ).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(RuntimeLease.Main))
        )
      ),
      (owned) =>
        Schema.decodeUnknownEffect(Release.Input)({
          did,
          generation: owned.generation,
          leaseId: owned.leaseId,
        }).pipe(
          Effect.flatMap((input) =>
            rpc("lease.release", () => stub.releaseLease(JSON.stringify(input)))
          ),
          Effect.ignore
        )
    );

    const renew = Effect.fn("AgentMailbox.renew")(
      function* renew() {
        const input = yield* Schema.decodeUnknownEffect(Renew.Input)({
          did,
          expiresAt: expiresAt(yield* Clock.currentTimeMillis),
          generation: lease.generation,
          leaseId: lease.leaseId,
        });

        lease = yield* rpc("lease.renew", () =>
          stub.renewLease(JSON.stringify(input))
        ).pipe(
          Effect.flatMap(
            Schema.decodeEffect(Schema.fromJsonString(RuntimeLease.Main))
          )
        );
      },
      Effect.mapError(
        () =>
          new HarnessFailure({
            operation: "lease.renew",
            reason: "Cannot renew runtime lease",
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
          yield* renew();

          const decoded = Send.Input.make({
            envelope,
            generation: lease.generation,
            leaseId: lease.leaseId,
          });

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
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(HarnessFailure)(error)
        ? error
        : new HarnessFailure({
            operation: "lease.acquire",
            reason: "Runtime lease unavailable",
          })
    )
  );
