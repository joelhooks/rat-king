import type * as Defs from "@rat-king/lexicon/defs";
import type * as List from "@rat-king/lexicon/mailbox.list";
import * as RuntimeLease from "@rat-king/lexicon/runtime.lease";
import { XrpcFailure as XrpcFailureClass } from "@rat-king/lexicon/xrpc-failure";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Context, Effect, Schema } from "effect";

import { failure } from "./failure.ts";

export interface Message {
  readonly canonicalBytes: string;
  readonly envelope: Defs.EncryptedEnvelopeValue;
  readonly admission: Defs.ReceiptValue;
  readonly current: Defs.ReceiptValue;
}

const LegacyLease = Schema.Struct({
  expiresAt: Schema.Int,
  generation: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  ),
  leaseId: Schema.String,
});

export const Lease = Schema.Union([
  Schema.Struct({
    ...LegacyLease.fields,
    did: RuntimeLease.Main.schema.fields.did,
    harness: RuntimeLease.Main.schema.fields.harness,
    issuedAt: Schema.Int,
  }),
  LegacyLease,
]);

export type LeaseValue = typeof Lease.Type;

export type Event = List.OutputValue["events"][number];

export interface Transaction {
  readonly recipient: () => string;
  readonly get: (sender: string, tid: string) => Message | undefined;
  readonly put: (message: Message) => void;
  readonly watermark: () => number;
  readonly append: (event: Event) => void;
  readonly events: (
    after: number,
    through: number,
    limit: number
  ) => readonly Event[];
  readonly lease: () => LeaseValue | undefined;
  readonly setLease: (lease: LeaseValue) => void;
  readonly cursorSecret: () => Uint8Array;
  readonly document: () => Defs.DidDocumentValue | undefined;
  readonly setDocument: (document: Defs.DidDocumentValue) => void;
}

export class MailboxStore extends Context.Service<
  MailboxStore,
  {
    readonly transaction: <A>(
      operation: (tx: Transaction) => A
    ) => Effect.Effect<A, XrpcFailure>;
  }
>()("mailbox/Store") {}

export const storageOperation = <A>(operation: () => A) =>
  Effect.try({
    catch: (cause) =>
      Schema.is(XrpcFailureClass)(cause)
        ? cause
        : failure("MailboxUnavailable", 503),
    try: operation,
  });
