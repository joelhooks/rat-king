import type * as Defs from "@rat-king/lexicon/defs";
import type * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as RuntimeLease from "@rat-king/lexicon/runtime.lease";
import type * as Release from "@rat-king/lexicon/runtime.releaseLease";
import type * as Renew from "@rat-king/lexicon/runtime.renewLease";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect";

import { base64url } from "./auth.ts";
import { failure } from "./failure.ts";
import { redeliver } from "./redelivery.ts";
import { MailboxStore } from "./store.ts";
import type { LeaseValue, Transaction } from "./store.ts";
import { tid } from "./tid.ts";

export interface Fence {
  readonly leaseId: string;
  readonly generation: number;
}

export const validLease = (tx: Transaction, fence: Fence, now: number) => {
  const lease = tx.lease();

  if (
    !lease ||
    lease.leaseId !== fence.leaseId ||
    lease.generation !== fence.generation ||
    lease.expiresAt <= now
  ) {
    throw failure("LeaseMismatch", 409);
  }

  return lease;
};

const sameHarness = Schema.toEquivalence(
  RuntimeLease.Main.schema.fields.harness
);

const sameAttempt = (
  current: LeaseValue,
  hash: string | null
): current is Extract<LeaseValue, { readonly did: string }> =>
  hash !== null && "did" in current && current.attemptHash === hash;

const resumes = (current: LeaseValue, input: Acquire.InputValue, now: number) =>
  current.expiresAt > now &&
  input.leaseId === current.leaseId &&
  input.generation === current.generation &&
  "harness" in current &&
  sameHarness(input.harness, current.harness);

const fullLease = (lease: LeaseValue): RuntimeLease.MainValue => {
  if (!("did" in lease)) {
    throw failure("LeaseNotFound", 404);
  }

  const { attemptHash: _private, ...publicLease } = lease;

  return Schema.decodeUnknownSync(RuntimeLease.Main)({
    ...publicLease,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(lease.expiresAt)),
    issuedAt: DateTime.formatIso(DateTime.makeUnsafe(lease.issuedAt)),
  });
};

const attemptDigest = Effect.fn("Lease.attemptDigest")(function* digest(
  attempt: string | undefined
) {
  if (attempt === undefined) {
    return null;
  }

  if (!/^[0-9a-f]{32}$/u.test(attempt)) {
    return yield* failure("InvalidRequest", 400, "Invalid acquire credential");
  }

  const bytes = new TextEncoder().encode(attempt);

  const hash = yield* Effect.tryPromise(
    crypto.subtle.digest.bind(crypto.subtle, "SHA-256", bytes)
  ).pipe(Effect.mapError(() => failure("MailboxUnavailable", 503)));

  return base64url(new Uint8Array(hash));
});

const replayAttempt = (
  current: LeaseValue | undefined,
  input: Acquire.InputValue,
  hash: string | null,
  now: number
) => {
  if (!current || !sameAttempt(current, hash)) {
    return null;
  }

  if (
    current.did !== input.did ||
    !sameHarness(input.harness, current.harness)
  ) {
    throw failure("LeaseHeld", 409);
  }

  if (current.expiresAt <= now) {
    throw failure("AcquireAttemptExpired", 409);
  }

  return fullLease(current);
};

const expiry = (now: number, requested: string) => {
  const expiresAt = Date.parse(requested);

  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw failure("InvalidRequest");
  }

  return Math.min(expiresAt, now + 300_000);
};

const checkHarness = (harness: Acquire.InputValue["harness"]) => {
  if (
    [
      "sh.mschf.ratking.runtime.lease#pi",
      "sh.mschf.ratking.runtime.lease#claude",
      "sh.mschf.ratking.runtime.lease#codex",
      "sh.mschf.ratking.runtime.lease#opencode",
    ].includes(harness.$type) &&
    !Schema.is(Schema.Struct({ sessionId: Schema.NonEmptyString }))(harness) &&
    !Schema.is(Schema.Struct({ paneId: Schema.NonEmptyString }))(harness)
  ) {
    throw failure(
      "InvalidRequest",
      400,
      "Harness requires a sessionId or paneId"
    );
  }
};

export interface LeaseInterface {
  readonly acquire: (
    input: Acquire.InputValue
  ) => Effect.Effect<RuntimeLease.MainValue, XrpcFailure>;
  readonly renew: (
    input: Renew.InputValue
  ) => Effect.Effect<RuntimeLease.MainValue, XrpcFailure>;
  readonly release: (
    input: Release.InputValue
  ) => Effect.Effect<undefined, XrpcFailure>;
  readonly resolve: (
    did: string
  ) => Effect.Effect<RuntimeLease.MainValue, XrpcFailure>;
  readonly check: (fence: Fence) => Effect.Effect<void, XrpcFailure>;
  readonly checkSend: (fence: {
    readonly leaseId?: string;
    readonly generation?: number;
  }) => Effect.Effect<void, XrpcFailure>;
}

export class LeaseAuthority extends Context.Service<
  LeaseAuthority,
  LeaseInterface
>()("mailbox/LeaseAuthority") {}

const makeLeases = (store: typeof MailboxStore.Service): LeaseInterface =>
  LeaseAuthority.of({
    acquire: Effect.fn("Lease.acquire")(function* acquire(input) {
      const attemptHash = yield* attemptDigest(input.attempt);
      const now = yield* Clock.currentTimeMillis;

      return yield* store.transaction((tx) => {
        if (input.did !== tx.recipient()) {
          throw failure("Forbidden", 403);
        }

        checkHarness(input.harness);

        const current = tx.lease();
        const replay = replayAttempt(current, input, attemptHash, now);

        if (replay !== null) {
          return replay;
        }

        const expiresAt = expiry(now, input.expiresAt);

        if (
          current &&
          current.expiresAt > now &&
          (input.leaseId !== current.leaseId ||
            input.generation !== current.generation)
        ) {
          throw failure("LeaseHeld", 409);
        }

        if (current && resumes(current, input, now)) {
          const resumed = { ...current, expiresAt };

          if (attemptHash !== null) {
            Object.assign(resumed, { attemptHash });
          }

          if (input.renders !== undefined) {
            Object.assign(resumed, { renders: input.renders });
          }

          tx.setLease(resumed);

          return fullLease(resumed);
        }

        const generation = (current?.generation ?? 0) + 1;

        if (!Number.isSafeInteger(generation)) {
          throw failure("InvalidRequest", 400, "Generation exhausted");
        }

        const lease = {
          did: input.did,
          expiresAt,
          generation,
          harness: input.harness,
          issuedAt: now,
          leaseId: tid(now, crypto.getRandomValues(new Uint16Array(1))[0] ?? 0),
        };

        if (input.renders !== undefined) {
          Object.assign(lease, { renders: input.renders });
        }

        if (attemptHash !== null) {
          Object.assign(lease, { attemptHash });
        }

        tx.setLease(lease);
        tx.setRetirement(undefined);
        redeliver(tx, now);

        return fullLease(lease);
      });
    }),
    check: Effect.fn("Lease.check")(function* check(fence) {
      const now = yield* Clock.currentTimeMillis;
      yield* store.transaction((tx) => {
        validLease(tx, fence, now);
      });
    }),
    checkSend: Effect.fn("Lease.checkSend")(function* checkSend(fence) {
      const now = yield* Clock.currentTimeMillis;
      yield* store.transaction((tx) => {
        const lease = tx.lease();

        if (
          (lease && lease.expiresAt > now) ||
          fence.leaseId !== undefined ||
          fence.generation !== undefined
        ) {
          if (fence.leaseId === undefined || fence.generation === undefined) {
            throw failure("LeaseMismatch", 409);
          }

          validLease(
            tx,
            { generation: fence.generation, leaseId: fence.leaseId },
            now
          );
        }
      });
    }),
    release: Effect.fn("Lease.release")(function* release(input) {
      const now = yield* Clock.currentTimeMillis;

      return yield* store.transaction((tx): undefined => {
        if (input.did !== tx.recipient()) {
          throw failure("Forbidden", 403);
        }

        tx.setLease({ ...validLease(tx, input, now), expiresAt: now });
      });
    }),
    renew: Effect.fn("Lease.renew")(function* renew(input) {
      const now = yield* Clock.currentTimeMillis;

      return yield* store.transaction((tx) => {
        if (input.did !== tx.recipient()) {
          throw failure("Forbidden", 403);
        }

        const lease = {
          ...validLease(tx, input, now),
          expiresAt: expiry(now, input.expiresAt),
        };

        if (input.renders !== undefined) {
          Object.assign(lease, { renders: input.renders });
        }

        const result = fullLease(lease);
        tx.setLease(lease);

        return result;
      });
    }),
    resolve: Effect.fn("Lease.resolve")(function* resolve(did) {
      const now = yield* Clock.currentTimeMillis;

      return yield* store.transaction((tx) => {
        if (did !== tx.recipient()) {
          throw failure("Forbidden", 403);
        }

        const lease = tx.lease();

        if (!lease || lease.expiresAt <= now) {
          throw failure("LeaseNotFound", 404);
        }

        return fullLease(lease);
      });
    }),
  });

export const leaseLayer = Layer.effect(
  LeaseAuthority,
  Effect.gen(function* leaseLayer() {
    return makeLeases(yield* MailboxStore);
  })
);

export interface MailboxPolicy {
  readonly delegation?: boolean;
  readonly resolvers: readonly string[];
  readonly operators: readonly string[];
  readonly staticDocuments: readonly Defs.DidDocumentValue[];
}
