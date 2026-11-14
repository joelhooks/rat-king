import type * as Defs from "@rat-king/lexicon/defs";
import { DateTime } from "effect";

import { failure } from "./failure.ts";
import type { LeaseValue, RetirementValue, Transaction } from "./store.ts";

export const isoTime = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

export const retiredMessage = (retirement: RetirementValue) =>
  `${retirement.name} was retired at ${isoTime(retirement.retiredAt)}; ${
    retirement.successor === undefined
      ? "no successor"
      : `current row is ${retirement.successor}`
  }`;

export const refuseRetired = (tx: Transaction) => {
  const retirement = tx.retirement();

  if (retirement !== undefined) {
    throw failure("Retired", 410, retiredMessage(retirement));
  }
};

export const standingOf = (
  tx: Transaction,
  staticDocuments: readonly Defs.DidDocumentValue[]
) => {
  const recipient = tx.recipient();

  return {
    exists:
      tx.document() !== undefined ||
      staticDocuments.some((document) => document.id === recipient),
    retirement: tx.retirement(),
  };
};

export const markRetired = (
  tx: Transaction,
  staticDocuments: readonly Defs.DidDocumentValue[],
  retirement: RetirementValue,
  holderMayRetire: boolean
) => {
  if (!standingOf(tx, staticDocuments).exists) {
    throw failure("NameNotFound", 404);
  }

  const lease = tx.lease();

  if (
    !holderMayRetire &&
    lease !== undefined &&
    lease.expiresAt > retirement.retiredAt
  ) {
    throw failure(
      "LeaseLive",
      409,
      `${retirement.name} is held by a live reader until ${isoTime(lease.expiresAt)}; nothing was retired. Retire it after the reader releases or its lease expires.`
    );
  }

  tx.setRetirement(retirement);

  return retirement;
};

export const repointRetirement = (
  tx: Transaction,
  successor: string,
  updatedAt: number
) => {
  const current = tx.retirement();

  if (current === undefined) {
    throw failure("NotRetired", 409);
  }

  if (current.successor === successor) {
    return current;
  }

  const next: RetirementValue = { ...current, successor, updatedAt };

  tx.setRetirement(next);

  return next;
};

export interface Presence {
  readonly renders?: readonly string[];
  readonly held: boolean;
  readonly lastHeldAt?: number;
}

export const presenceOf = (
  lease: LeaseValue | undefined,
  now: number
): Presence => {
  if (lease === undefined) {
    return { held: false };
  }

  if (lease.expiresAt <= now) {
    return { held: false, lastHeldAt: lease.expiresAt };
  }

  return { held: true, lastHeldAt: now, renders: lease.renders ?? [] };
};
