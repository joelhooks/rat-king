import type * as Defs from "@rat-king/lexicon/defs";
import type * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as RuntimeLease from "@rat-king/lexicon/runtime.lease";
import type * as Release from "@rat-king/lexicon/runtime.releaseLease";
import type * as Renew from "@rat-king/lexicon/runtime.renewLease";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect";

import { failure } from "./failure.ts";
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

const fullLease = (lease: LeaseValue): RuntimeLease.MainValue => {
  if (!("did" in lease)) {
    throw failure("LeaseNotFound", 404);
  }

  return Schema.decodeUnknownSync(RuntimeLease.Main)({
    ...lease,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(lease.expiresAt)),
    issuedAt: DateTime.formatIso(DateTime.makeUnsafe(lease.issuedAt)),
  });
};

const expiry = (now: number, requested: string) => {
  const expiresAt = Date.parse(requested);

  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw failure("InvalidRequest");
  }

  return Math.min(expiresAt, now + 300_000);
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
      const now = yield* Clock.currentTimeMillis;

      return yield* store.transaction((tx) => {
        if (input.did !== tx.recipient()) {
          throw failure("Forbidden", 403);
        }

        const expiresAt = expiry(now, input.expiresAt);

        if (
          [
            "sh.mschf.ratking.runtime.lease#pi",
            "sh.mschf.ratking.runtime.lease#claude",
            "sh.mschf.ratking.runtime.lease#codex",
            "sh.mschf.ratking.runtime.lease#opencode",
          ].includes(input.harness.$type) &&
          !Schema.is(Schema.Struct({ sessionId: Schema.NonEmptyString }))(
            input.harness
          ) &&
          !Schema.is(Schema.Struct({ paneId: Schema.NonEmptyString }))(
            input.harness
          )
        ) {
          throw failure(
            "InvalidRequest",
            400,
            "Harness requires a sessionId or paneId"
          );
        }

        const current = tx.lease();

        if (
          current &&
          current.expiresAt > now &&
          (input.leaseId !== current.leaseId ||
            input.generation !== current.generation)
        ) {
          throw failure("LeaseHeld", 409);
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

        tx.setLease(lease);

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
  readonly resolvers: readonly string[];
  readonly operators: readonly string[];
  readonly staticDocuments: readonly Defs.DidDocumentValue[];
}
