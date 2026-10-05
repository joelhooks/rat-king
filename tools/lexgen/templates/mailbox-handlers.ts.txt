import { Context } from "effect";
import type { Effect } from "effect";

import type * as PutDidDocument from "./admin.putDidDocument.ts";
import type * as Ack from "./mailbox.ack.ts";
import type * as Deliver from "./mailbox.deliver.ts";
import type * as List from "./mailbox.list.ts";
import type * as Send from "./mailbox.send.ts";
import type * as AcquireLease from "./runtime.acquireLease.ts";
import type * as ReleaseLease from "./runtime.releaseLease.ts";
import type * as RenewLease from "./runtime.renewLease.ts";
import type * as ResolveLease from "./runtime.resolveLease.ts";
import type { XrpcFailure } from "./xrpc-failure.ts";

export interface HandlerInterface {
  readonly acquireLease: (
    input: AcquireLease.InputValue
  ) => Effect.Effect<AcquireLease.OutputValue, XrpcFailure>;
  readonly renewLease: (
    input: RenewLease.InputValue
  ) => Effect.Effect<RenewLease.OutputValue, XrpcFailure>;
  readonly releaseLease: (
    input: ReleaseLease.InputValue
  ) => Effect.Effect<ReleaseLease.OutputValue, XrpcFailure>;
  readonly resolveLease: (
    params: ResolveLease.ParamsValue
  ) => Effect.Effect<ResolveLease.OutputValue, XrpcFailure>;
  readonly deliver: (
    input: Deliver.InputValue
  ) => Effect.Effect<Deliver.OutputValue, XrpcFailure>;
  readonly putDidDocument: (
    input: PutDidDocument.InputValue
  ) => Effect.Effect<PutDidDocument.OutputValue, XrpcFailure>;
  readonly send: (
    input: Send.InputValue
  ) => Effect.Effect<Send.OutputValue, XrpcFailure>;
  readonly ack: (
    input: Ack.InputValue
  ) => Effect.Effect<Ack.OutputValue, XrpcFailure>;
  readonly list: (
    params: List.ParamsValue
  ) => Effect.Effect<List.OutputValue, XrpcFailure>;
}

export class MailboxHandlers extends Context.Service<
  MailboxHandlers,
  HandlerInterface
>()("@rat-king/lexicon/MailboxHandlers") {}
