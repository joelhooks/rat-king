import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import {
  MailboxClientError,
  ownIdentity,
  prepare,
} from "@rat-king/mailbox-client";
import {
  Clock,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";
import { identityFromGrant } from "../../../packages/ratking-client/src/desk-signer-client.ts";
import {
  grantFailure,
  Request,
  Response as GrantResponse,
  signerRequests,
} from "../../../packages/ratking-client/src/desk-signer-wire.ts";
import { readerLeaseJournal } from "../../../packages/ratking-client/src/reader-lease.ts";
import {
  authenticateClaims,
  ReplayAuthority,
  staticResolver,
} from "../src/auth.ts";
import { LeaseAuthority, leaseLayer } from "../src/lease.ts";
import { testStoreFor } from "./helpers.ts";

const did = "did:web:reader.example";

const serviceDid = "did:web:mailbox.example";

const session = "grant-replay";

const harness = {
  $type: "sh.mschf.ratking.runtime.lease#pi",
  sessionId: session,
} as const;

const stop = new MailboxClientError({
  reason: "Fixture stopped before subscribing",
});

const noOp = () => Effect.void;

it.effect(
  "a grant-authenticated reader replays a lost acquire and checkpoints the same lease tuple",
  () =>
    Effect.gen(function* grantReplay() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const { layer } = yield* testStoreFor(did);

      const leases = yield* LeaseAuthority.pipe(
        Effect.provide(leaseLayer.pipe(Layer.provide(layer)))
      );

      const privateIdentity = yield* identity(did);
      const peer = yield* document(privateIdentity);

      const verifier = Layer.merge(
        staticResolver([peer]),
        Layer.succeed(ReplayAuthority, { consume: noOp })
      );

      const credentials: (string | undefined)[] = [];
      const tokenIds: string[] = [];

      const http = HttpClient.make((request) =>
        Effect.gen(function* receive() {
          const acquire = request.url.endsWith(`/${Acquire.Method.nsid}`);
          const nsid = acquire ? Acquire.Method.nsid : Release.Method.nsid;
          expect(request.url).toMatch(`/${nsid}`);

          const claims = yield* authenticateClaims({
            audience: `${serviceDid}#mailbox`,
            authorization: request.headers.authorization ?? null,
            now: yield* Clock.currentTimeMillis,
            nsid,
          }).pipe(Effect.provide(verifier));

          expect(claims.iss).toBe(did);

          if (!Predicate.isTagged(request.body, "Uint8Array")) {
            return yield* Effect.die("Expected a JSON lease request");
          }

          const text = new TextDecoder().decode(request.body.body);

          if (!acquire) {
            const input = yield* Schema.decodeEffect(
              Schema.fromJsonString(Release.Input)
            )(text);

            yield* leases.release(input);

            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 204 })
            );
          }

          const input = yield* Schema.decodeEffect(
            Schema.fromJsonString(Acquire.Input)
          )(text);

          tokenIds.push(claims.jti);
          credentials.push(input.attempt);
          const lease = yield* leases.acquire(input);

          const response =
            credentials.length === 1
              ? Response.json({ error: "MailboxUnavailable" }, { status: 503 })
              : Response.json({ lease });

          return HttpClientResponse.fromWeb(request, response);
        }).pipe(Effect.orDie)
      );

      const launch = Effect.fn("Test.launchGrant")(function* launch() {
        const respond = yield* signerRequests("reader", privateIdentity);

        const grant = yield* identityFromGrant(
          (input) =>
            Schema.encodeEffect(Request)(input).pipe(
              Effect.flatMap(respond),
              Effect.flatMap(Schema.decodeEffect(GrantResponse)),
              Effect.mapError(grantFailure)
            ),
          "reader",
          did
        );

        const own = yield* ownIdentity(grant);

        return yield* prepare({
          endpoint: "https://mailbox.example",
          own,
          peers: [peer],
          serviceDid,
        }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      });

      const first = yield* launch();
      const initial = yield* readerLeaseJournal(root, did, session);
      const pending = yield* initial.pending(Option.none());

      const missed = yield* first
        .consume(noOp, {
          acquireAttempt: pending.attempt,
          harness,
          onAcquired: initial.save,
        })
        .pipe(Effect.flip);

      expect(missed.error).toBe("MailboxUnavailable");
      const committed = yield* leases.resolve(did);

      const tuple = {
        generation: committed.generation,
        leaseId: committed.leaseId,
      };

      const second = yield* launch();
      const restarted = yield* readerLeaseJournal(root, did, session);
      const retry = yield* restarted.pending(Option.none());

      const outcome = yield* second
        .consume(noOp, {
          acquireAttempt: retry.attempt,
          harness,
          onAcquired: restarted.save,
          onLease: (lease) => {
            expect({
              generation: lease.generation,
              leaseId: lease.leaseId,
            }).toEqual(tuple);

            return Effect.fail(stop);
          },
        })
        .pipe(Effect.flip);

      expect(outcome).toEqual(stop);
      expect(credentials).toEqual([pending.attempt, pending.attempt]);
      expect(new Set(tokenIds).size).toBe(2);
      const checkpoint = yield* restarted.pending(Option.none());
      expect(checkpoint.resume).toEqual(tuple);
      expect(checkpoint.attempt).not.toBe(pending.attempt);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
