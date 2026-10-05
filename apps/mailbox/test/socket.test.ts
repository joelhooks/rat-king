// @effect-diagnostics globalFetch:off -- Owned celld loopback test adapter.
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Socket event and HTTP adapters. */
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxClient } from "@rat-king/lexicon/mailbox-client";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as Deliver from "@rat-king/lexicon/mailbox.deliver";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Subscribe from "@rat-king/lexicon/mailbox.subscribe";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import * as Resolve from "@rat-king/lexicon/runtime.resolveLease";
import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Arbitrary, Clock, DateTime, Effect, Schedule, Schema } from "effect";
import { describe, expect } from "vitest";

import {
  sealed,
  recipientDid,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import { base64url, serviceToken } from "../src/auth.ts";
import { socketCodes } from "../src/socket.ts";
import { tid } from "../src/tid.ts";
import { celldNode, io, TestFailure } from "./celld.ts";
import { documents } from "./helpers.ts";
import { httpClient } from "./http-client.ts";

const Sends = Schema.Array(
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(1000)
  )
).check(Schema.isMinLength(1), Schema.isMaxLength(5));

const socketProbe = (url: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocket(url);
      const notices: Subscribe.MessageValue[] = [];
      let closedCode: number | undefined;
      socket.addEventListener("message", (event) => {
        notices.push(
          Schema.decodeUnknownSync(Schema.fromJsonString(Subscribe.Message))(
            event.data
          )
        );
      });
      socket.addEventListener("close", (event) => {
        closedCode = event.code;
      });

      const opened = Effect.callback<boolean, TestFailure>((resume) => {
        if (socket.readyState === WebSocket.OPEN) {
          resume(Effect.succeed(true));

          return Effect.void;
        }

        const onOpen = () => {
          resume(Effect.succeed(true));
        };

        const onError = () => {
          resume(
            Effect.fail(
              new TestFailure({ message: "WebSocket upgrade refused" })
            )
          );
        };

        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onError);

        return Effect.sync(() => {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
        });
      }).pipe(Effect.timeout("10 seconds"));

      return { closedCode: () => closedCode, notices, opened, socket };
    }),
    (owned) =>
      Effect.sync(() => {
        owned.socket.close();
      })
  );

const awaitCondition = (condition: () => boolean) =>
  Effect.sync(condition).pipe(
    Effect.filterOrFail(
      (ready) => ready,
      () => new TestFailure({ message: "Socket condition not ready" })
    ),
    Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 800 }),
    Effect.timeout("10 seconds")
  );

describe.skipIf(
  process.env.RAT_KING_CELLD === undefined || process.env.RAT_KING_CELLD === ""
)("celld hibernatable push", () => {
  it.live.prop(
    "each committed append emits only its sequence; timeout, issuer, stale fence and generation revoke sockets",
    [Arbitrary.schema(Sends)],
    ([sends]) =>
      Effect.gen(function* socketProof() {
        const sample = yield* sealed();

        const docs = yield* documents(
          sample.keys.sender.publicKey,
          sample.keys.recipient.publicKey
        );

        const baseUrl = yield* celldNode(
          process.env.RAT_KING_CELLD ?? "",
          JSON.stringify(docs)
        );

        const recipient = yield* MailboxClient.pipe(
          Effect.provide(
            httpClient(baseUrl, recipientDid, sample.keys.sender.privateKey)
          )
        );

        const sender = yield* MailboxClient.pipe(
          Effect.provide(
            httpClient(baseUrl, senderDid, sample.keys.sender.privateKey)
          )
        );

        let acquisition = 0;

        const acquire = () =>
          Effect.gen(function* acquireLease() {
            acquisition += 1;

            return (yield* recipient
              .acquireLease(
                yield* Schema.decodeUnknownEffect(Acquire.Input)({
                  did: recipientDid,
                  expiresAt: DateTime.formatIso(
                    DateTime.makeUnsafe(
                      (yield* Clock.currentTimeMillis) + 60_000
                    )
                  ),
                  harness: {
                    $type: "sh.mschf.ratking.runtime.lease#pi",
                    sessionId: "socket-proof",
                  },
                })
              )
              .pipe(
                Effect.mapError(
                  (error) =>
                    new TestFailure({
                      message: `Socket lease acquire ${acquisition === 1 ? "initially" : "after expiry"} refused: ${Schema.is(XrpcFailure)(error) ? error.error : error._tag}`,
                    })
                )
              )).lease;
          });

        let lease = yield* acquire();

        const fence = () =>
          Schema.decodeUnknownSync(Release.Input)({
            did: recipientDid,
            generation: lease.generation,
            leaseId: lease.leaseId,
          });

        yield* Effect.addFinalizer(() =>
          recipient.releaseLease(fence()).pipe(
            Effect.catchIf(
              (error) =>
                Schema.is(XrpcFailure)(error) &&
                error.error === "LeaseMismatch",
              () => Effect.void
            ),
            Effect.orDie
          )
        );

        const url = () => {
          const endpoint = new URL(
            Subscribe.Method.path,
            baseUrl.replace("http:", "ws:")
          );

          endpoint.searchParams.set("recipientDid", recipientDid);
          endpoint.searchParams.set("leaseId", lease.leaseId);
          endpoint.searchParams.set("generation", String(lease.generation));

          return endpoint.toString();
        };

        const authenticate = (
          socket: WebSocket,
          issuer: string,
          tokenId?: string
        ) =>
          Effect.gen(function* authenticateSocket() {
            const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

            const token = yield* serviceToken(
              {
                aud: "did:web:service.example#mailbox",
                exp: now + 60,
                iat: now,
                iss: issuer,
                jti:
                  tokenId ??
                  base64url(crypto.getRandomValues(new Uint8Array(16))),
                lxm: Subscribe.Method.nsid,
              },
              sample.keys.sender.privateKey
            );

            socket.send(
              JSON.stringify({
                $type: "sh.mschf.ratking.mailbox.subscribe#auth",
                ...Subscribe.Auth.make({ token }),
              })
            );
          });

        const states = () =>
          io(() =>
            fetch(
              `${baseUrl}/test/sockets?recipientDid=${encodeURIComponent(recipientDid)}`
            )
          ).pipe(
            Effect.flatMap((response) => io(() => response.json())),
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ states: Schema.Array(Schema.String) })
              )
            )
          );

        const authenticated = () =>
          states().pipe(
            Effect.filterOrFail(
              (result) => result.states.includes("authenticated"),
              () => new TestFailure({ message: "Authentication pending" })
            ),
            Effect.retry({
              schedule: Schedule.spaced("10 millis"),
              times: 200,
            }),
            Effect.timeout("5 seconds")
          );

        const timeout = yield* socketProbe(url());
        yield* timeout.opened;
        yield* awaitCondition(() => timeout.closedCode() !== undefined);
        expect(timeout.closedCode()).toBe(socketCodes.timeout);

        const wrong = yield* socketProbe(url());
        yield* wrong.opened;
        yield* authenticate(wrong.socket, senderDid);
        yield* awaitCondition(() => wrong.closedCode() !== undefined);
        expect(wrong.closedCode()).toBe(socketCodes.auth);

        const startMillis = yield* Clock.currentTimeMillis;

        const envelopeFor = (index: number, value: number) =>
          Schema.decodeUnknownEffect(Schema.toType(Defs.EncryptedEnvelope))({
            ...sample.envelope,
            aad: {
              ...sample.envelope.aad,
              messageId: tid(startMillis + index, value),
            },
          });

        yield* sender.send({ envelope: yield* envelopeFor(0, 0) });

        const active = yield* socketProbe(url());
        yield* active.opened;
        yield* authenticate(active.socket, recipientDid);
        yield* authenticated();
        yield* awaitCondition(() => active.notices.length === 1);

        const barrierPage = yield* recipient.list(
          yield* Schema.decodeUnknownEffect(List.Params)({ recipientDid })
        );

        expect(active.notices).toEqual([
          {
            $type: "sh.mschf.ratking.mailbox.subscribe#notice",
            seq: barrierPage.throughSeq,
          },
        ]);
        expect(barrierPage.throughSeq).toBe(1);

        const racing = yield* socketProbe(url());
        yield* racing.opened;
        yield* Effect.all(
          [
            authenticate(racing.socket, recipientDid),
            sender.send({ envelope: yield* envelopeFor(1, 0) }),
          ],
          { concurrency: "unbounded" }
        );
        yield* awaitCondition(() => racing.notices.length > 0);
        const [firstRacing] = racing.notices;

        const racingBarrier = yield* Schema.decodeUnknownEffect(
          Subscribe.Notice
        )(firstRacing);

        expect([1, 2]).toContain(racingBarrier.seq);

        for (const [index, value] of sends.entries()) {
          const envelope = yield* envelopeFor(index + 2, value);

          const admitted = yield* sender.send({ envelope });

          const delivery = yield* Schema.decodeUnknownEffect(Deliver.Input)({
            ...fence(),
            message: admitted.receipt.message,
            recipientDid,
          });

          const delivered = yield* recipient.deliver(delivery);
          expect(yield* recipient.deliver(delivery)).toEqual(delivered);
          yield* recipient.ack(
            yield* Schema.decodeUnknownEffect(Ack.Input)(delivery)
          );
          yield* sender.send({ envelope });

          const page = yield* recipient.list(
            yield* Schema.decodeUnknownEffect(List.Params)({
              limit: 100,
              recipientDid,
            })
          );

          yield* awaitCondition(
            () => active.notices.length === page.throughSeq
          );

          const events = yield* Schema.decodeUnknownEffect(
            Schema.toType(
              Schema.Array(Schema.Union([Defs.MessageEvent, Defs.ReceiptEvent]))
            )
          )(page.events);

          const afterBarrier = (seq: number) => [
            { $type: "sh.mschf.ratking.mailbox.subscribe#notice", seq },
            ...events.flatMap((event) =>
              event.seq > seq
                ? [
                    {
                      $type: "sh.mschf.ratking.mailbox.subscribe#notice",
                      seq: event.seq,
                    },
                  ]
                : []
            ),
          ];

          expect(active.notices).toEqual(afterBarrier(barrierPage.throughSeq));
          yield* awaitCondition(
            () =>
              racing.notices.length === page.throughSeq - racingBarrier.seq + 1
          );
          expect(racing.notices).toEqual(afterBarrier(racingBarrier.seq));
          expect(active.notices.at(-1)?.seq).toBe(page.throughSeq);
        }

        ({ lease } = yield* recipient.renewLease(
          yield* Schema.decodeUnknownEffect(Renew.Input)({
            ...fence(),
            expiresAt: DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 1000)
            ),
          })
        ));
        yield* recipient
          .resolveLease(
            yield* Schema.decodeUnknownEffect(Resolve.Params)({
              did: recipientDid,
            })
          )
          .pipe(
            Effect.flatMap(() =>
              Effect.fail(new TestFailure({ message: "Lease expiry pending" }))
            ),
            Effect.catchIf(
              (error) =>
                Schema.is(XrpcFailure)(error) &&
                error.error === "LeaseNotFound",
              () => Effect.void
            ),
            Effect.retry({
              schedule: Schedule.spaced("10 millis"),
              times: 500,
              while: (error) =>
                Schema.is(TestFailure)(error) &&
                error.message === "Lease expiry pending",
            }),
            Effect.timeout("10 seconds")
          );
        const older = lease;
        lease = yield* acquire();
        expect(lease.generation).toBe(older.generation + 1);
        yield* awaitCondition(() => active.closedCode() !== undefined);
        expect(active.closedCode()).toBe(socketCodes.stale);
        yield* awaitCondition(() => racing.closedCode() !== undefined);
        expect(racing.closedCode()).toBe(socketCodes.stale);

        const stale = yield* socketProbe(url());
        yield* stale.opened;
        yield* recipient.releaseLease(fence());
        yield* authenticate(stale.socket, recipientDid);
        yield* awaitCondition(() => stale.closedCode() !== undefined);
        expect(stale.closedCode()).toBe(socketCodes.stale);
        expect(stale.notices).toEqual([]);
      }).pipe(Effect.scoped),
    {
      arbitrary: { runs: 3, seed: process.env.RAT_KING_SOCKET_SEED },
      timeout: 90_000,
    }
  );
});
