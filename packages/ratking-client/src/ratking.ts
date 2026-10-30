/* oxlint-disable eslint/max-classes-per-file, eslint/no-redeclare -- Effect service, Schema errors and the reader state enum share their owning port. */
import * as Wake from "@rat-king/lexicon/agentgraph.wake";
import type * as Prefs from "@rat-king/lexicon/attention.prefs";
import type * as AttentionStatus from "@rat-king/lexicon/attention.status";
import * as Defs from "@rat-king/lexicon/defs";
import * as Retire from "@rat-king/lexicon/identity.retireName";
import * as Runtime from "@rat-king/lexicon/runtime";
import type * as Lease from "@rat-king/lexicon/runtime.lease";
import { Transport } from "@rat-king/lexicon/transport";
import { signedTurn } from "@rat-king/lexicon/turns";
import {
  MailboxClientError,
  ownIdentity,
  prepare,
  readerCannotRender,
  recordType,
  SendOutcomes,
  transportLayer,
} from "@rat-king/mailbox-client";
import type {
  ConsumeOptions,
  IdentityValue,
  LeaseFence,
  MessageMeta,
  OpenedMessage,
  PeerDocument,
  SendOutcome,
} from "@rat-king/mailbox-client";
import * as Deadline from "@rat-king/mailbox-client/deadline";
import {
  Clock,
  Context,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Ref,
  Result,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import type { Scope } from "effect";
import { HttpClient } from "effect/http";

import type { RetryEvent } from "../../mailbox-client/src/retry-metrics.ts";
import { AskJournal, askAge, openAsks } from "./asks.ts";
import type { AsksApi, PendingAskValue } from "./asks.ts";
import { forwardNames } from "./attend.ts";
import type { Levers } from "./attend.ts";
import { attentionReader } from "./attention.ts";
import type {
  AttentionApi,
  AttentionChange,
  AttentionValue,
} from "./attention.ts";
import { AskAimedAtCc, ccLint, ccRefusal } from "./cc-lint.ts";
import { Settings } from "./config.ts";
import { injects, recipientLevels } from "./delivery.ts";
import type { RecipientLevelValue } from "./delivery.ts";
import { digestFor } from "./digest.ts";
import { Directory, writePrivateJson } from "./directory.ts";
import type { Listed, Resolved } from "./directory.ts";
import { quietAsk, reasonOf } from "./errors.ts";
import type { QuietAsk } from "./errors.ts";
import { claimName, ensureIdentity } from "./identity.ts";
import type { SessionFacts } from "./identity.ts";
import { Issuer } from "./issuer.ts";
import {
  readerRetryDelay,
  recoverHeld,
  parkUntilClaimOrRetry,
  successionRetryDelay,
  UNIDENTIFIED,
} from "./lease-recovery.ts";
import {
  AgentName,
  addressedElsewhere,
  canonicalName,
  didFor,
  isReserved,
  provisionLabel,
  secretName,
  verifiedSender,
} from "./name.ts";
import {
  decodePayload,
  decodeRecord,
  PayloadJson,
  RecordJson,
  replyRef,
  SUMMARY_MAX,
  wakeIntent,
} from "./payload.ts";
import type {
  Inbound,
  InboundRecord,
  KindValue,
  LexiconRecordValue,
  PayloadValue,
} from "./payload.ts";
import { PRESENCE_TTL_MS, PresenceTimeout, presenceLine } from "./presence.ts";
import type { PresenceValue } from "./presence.ts";
import { quarantined, recover } from "./quarantine.ts";
import type { Quarantined } from "./quarantine.ts";
import {
  blockedByAncestor,
  errorTag,
  HEARTBEAT_EVERY,
  heldReason,
  HeartbeatJson,
} from "./reader-health.ts";
import type { ReaderHeartbeatValue } from "./reader-health.ts";
import { recentMap } from "./recent.ts";
import { RENDERS } from "./record-visibility.ts";
import {
  copiesOutbound,
  openRelay,
  deliverRelay,
  RelayHandled,
  RelayJournal,
  transferCustody,
} from "./relay.ts";
import type { RelayOutboundValue } from "./relay.ts";
import { awaitRestartGate } from "./restart-gate.ts";
import { countRetry, emptyRetries } from "./retry-counters.ts";
import { SecretStore } from "./secrets.ts";
import { replyRecipients, Threads, threadsLayer } from "./threads.ts";
import type { Received, Reply } from "./threads.ts";

export const NotDeliveredCode = Schema.Literals([
  "NotConfigured",
  "NoIdentity",
  "UnknownName",
  "Self",
  "NotAttempted",
  "Rejected",
  "Uncertain",
  "Refused",
  "Partial",
  "Retired",
  "ReaderCannotRender",
  "AskAimedAtCc",
]);

export class NotDelivered extends Schema.TaggedError<NotDelivered>()(
  "NotDelivered",
  {
    addressed: Schema.optionalKey(AskAimedAtCc),
    code: NotDeliveredCode,
    reason: Schema.String,
  }
) {}

export class AskFailed extends Schema.TaggedError<AskFailed>()("AskFailed", {
  code: Schema.Literals([
    "NoReply",
    "NoReader",
    "NoSuchMessage",
    "AmbiguousId",
  ]),
  reason: Schema.String,
}) {}

const SUCCESSION_WINDOW_MS = 900_000;

export class LeaseHeld extends Schema.TaggedError<LeaseHeld>()("LeaseHeld", {
  expiresAt: Schema.String,
  harness: Schema.String,
  holder: Schema.String,
  name: Schema.String,
  reason: Schema.String,
}) {}

export interface Attached {
  readonly did: string;
  readonly name: string;
  readonly secret: string;
}

export interface Located extends Attached {
  readonly held: boolean;
}

export interface LeaseHolder {
  readonly expiresAt: string;
  readonly generation: number;
  readonly harness: string;
  readonly live: boolean;
  readonly session: string;
}

export interface PeekOptions {
  readonly afterSeq?: number;
  readonly all?: boolean;
}

export interface Peeked {
  readonly encrypted: boolean;
  readonly received: Inbound | InboundRecord;
  readonly redelivered: boolean;
  readonly seq: number;
  readonly state: string;
}

export interface Unreadable {
  readonly id: string;
  readonly reason: string;
  readonly senderDid: string;
  readonly seq: number;
}

export interface Peek {
  readonly hasMore?: boolean;
  readonly messages: readonly Peeked[];
  readonly throughSeq: number;
  readonly unreadable: readonly Unreadable[];
}

export interface AttentionSnapshot {
  readonly enabled: boolean;
  readonly prefs: Prefs.MainValue;
  readonly status: AttentionStatus.MainValue;
}

export interface HoldOptions {
  readonly afterSeq?: number;
  readonly session: string;
}

export type HeldDelivery = (
  entry: Peeked,
  ack: Effect.Effect<void, NotDelivered>
) => Effect.Effect<void, NotDelivered>;

export type ReaderState = Data.TaggedEnum<{
  Starting: { readonly reason: string };
  Minting: { readonly name: string };
  Acquiring: { readonly name: string; readonly did: string };
  Live: {
    readonly name: string;
    readonly did: string;
    readonly generation: number;
    readonly expiresAt: string;
  };
  Retrying: {
    readonly name: Option.Option<string>;
    readonly attempt: number;
    readonly reason: string;
  };
  Refused: { readonly name: string; readonly reason: string };
  SendOnly: { readonly name: string; readonly reason: string };
}>;

export const ReaderState = Data.taggedEnum<ReaderState>();

export type ClaimOutcome = Data.TaggedEnum<{
  Idle: { readonly gate: "absent" };
  Requested: { readonly gate: "released" };
  Held: { readonly holder: LeaseHolder };
}>;

export const ClaimOutcome = Data.taggedEnum<ClaimOutcome>();

export class ReaderControl extends Context.Service<
  ReaderControl,
  { readonly claim: Effect.Effect<ClaimOutcome> }
>()("ratking/ReaderControl") {}

export const ADMISSION_TRIES = 10;

export const admissionBackoff = (count: number) =>
  Duration.seconds(Math.min(2 ** (count - 1), 15));

export const AdmissionBackoff = Context.Reference<
  (count: number) => Duration.Duration
>("RatKing.AdmissionBackoff", {
  defaultValue: () => admissionBackoff,
});

export interface Self {
  readonly name: string;
  readonly did: string;
  readonly identity: IdentityValue;
  readonly label?: () => Option.Option<string>;
}

interface Admitted {
  readonly delegated?: Defs.DelegationReceiptValue;
  readonly id: string;
  readonly seq: number;
  readonly to: string;
  readonly did: string;
}

const admissionOf = (
  target: { readonly did: string; readonly name: string },
  id: string,
  receipt: Defs.ReceiptValue
): Admitted => {
  const admitted: Admitted = {
    did: target.did,
    id,
    seq: receipt.seq,
    to: target.name,
  };

  if (receipt.delegated !== undefined) {
    Object.assign(admitted, { delegated: receipt.delegated });
  }

  return admitted;
};

export interface HandledAck {
  readonly acked: true;
  readonly id: string;
}

export interface Delivered extends Admitted {
  readonly presence?: string;
  readonly recipients?: readonly RecipientLevelValue[];
}

interface FrontLoops {
  readonly answered: (
    names: readonly string[]
  ) => Effect.Effect<void, NotDelivered>;
  readonly handled: (id: string) => Effect.Effect<void, NotDelivered>;
}

interface Sent {
  readonly from: string;
  readonly to: string;
  readonly cc: readonly string[];
  readonly body: string;
  readonly encrypted: boolean;
  readonly kind: KindValue;
  readonly thread: string;
  readonly replyTo: string | null;
  readonly summary: string | null;
}

const observed = (name: string, hook: Effect.Effect<void> | undefined) =>
  hook === undefined
    ? Effect.void
    : hook.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Rat King ${name} hook failed`, cause)
        ),
        Effect.uninterruptible
      );

const reportPhase = (
  options: Pick<SendOptions, "onPhase"> | undefined,
  phase: SendPhase
) => observed("phase", options?.onPhase?.(phase));

const oneLineSummary = (text: string) =>
  text.replaceAll(/\s+/gu, " ").trim().slice(0, SUMMARY_MAX);

const NAMELESS_REASON =
  "This Pi has no Rat King name. Nameless Pis don't register, to stop dead mailboxes, and workers never hold their desk's key. Set RATKING_PRINT_NAME or RATKING_NAME";

/* oxlint-disable typescript/no-generated-empty-object-type -- Effect TaggedEnum requires an intentionally empty payload for tag-only variants. */
export type SendPhase = Data.TaggedEnum<{
  Identity: Readonly<Record<never, never>>;
  Reader: Readonly<Record<never, never>>;
  Resolving: { readonly name: string };
  Sealing: Readonly<Record<never, never>>;
  Sending: Readonly<Record<never, never>>;
  Retrying: { readonly attempt: number; readonly reason: string };
  AwaitingReply: { readonly from: string };
}>;

/* oxlint-enable typescript/no-generated-empty-object-type */

export const SendPhase = Data.taggedEnum<SendPhase>();

const sealingPhase = (encrypt: boolean) =>
  encrypt ? SendPhase.Sealing() : SendPhase.Sending();

export interface SendOptions {
  readonly ccOnPurpose?: boolean;
  readonly copyTo?: string;
  readonly critical?: boolean;
  readonly encrypt?: boolean;
  readonly kind?: KindValue;
  readonly onDispatch?: Effect.Effect<void>;
  readonly onPhase?: (phase: SendPhase) => Effect.Effect<void>;
  readonly quiet?: true;
  readonly replyTo?: { readonly messageId: string; readonly senderDid: string };
  readonly summary?: string;
  readonly cc?: readonly string[];
  readonly thread?: string;
}

export const markVia = (
  via: string,
  body: string | LexiconRecordValue,
  options?: SendOptions
): Result.Result<
  { readonly body: string; readonly options: SendOptions },
  NotDelivered
> => {
  const text = Option.liftPredicate(body, Schema.is(Schema.String));

  if (Option.isNone(text)) {
    return Result.fail(
      new NotDelivered({
        code: "NoIdentity",
        reason:
          "This Pi has no Rat King name, so it cannot send a record. A typed record has no place for a via marker, so signed by the desk it would assert data as the desk. Give this Pi a name with RATKING_PRINT_NAME or RATKING_NAME",
      })
    );
  }

  const original = options?.summary ?? "";

  return Result.succeed({
    body: `↳ via headless Pi ${via}\n\n${text.value}`,
    options: {
      ...options,
      summary: oneLineSummary(
        `via ${via.replace(/ \([^)]*\)$/u, "")}${original === "" ? "" : ` · ${original}`}`
      ),
    },
  });
};

export type AskOptions = Pick<
  SendOptions,
  | "ccOnPurpose"
  | "critical"
  | "encrypt"
  | "cc"
  | "onDispatch"
  | "onPhase"
  | "quiet"
  | "summary"
> & {
  readonly dueBy?: number;
  readonly onDelivered?: Effect.Effect<void>;
  readonly wait?: boolean;
};

export interface Asked {
  readonly delivered: Delivered;
  readonly reply?: Reply;
}

interface RelayRoute {
  readonly message: (
    inbound: Inbound,
    settled: boolean,
    encrypted: boolean,
    redelivered: boolean
  ) => Effect.Effect<void, NotDelivered>;
  readonly record: (
    inbound: InboundRecord
  ) => Effect.Effect<void, NotDelivered>;
}

export type Deliver = (
  inbound: Inbound | InboundRecord,
  settled: boolean,
  ack?: Effect.Effect<void>
) => Effect.Effect<void>;

export interface Status {
  readonly openAsks?: number;
  readonly reader: ReaderState;
  readonly self: Option.Option<{ readonly name: string; readonly did: string }>;
  readonly endpoint: string;
  readonly quarantine: Quarantined;
}

export class RatKing extends Context.Service<
  RatKing,
  {
    readonly attention: AttentionApi["change"];
    readonly run: (
      facts: SessionFacts,
      deliver: Deliver
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly send: (
      to: string,
      body: string | LexiconRecordValue,
      options?: SendOptions
    ) => Effect.Effect<Delivered, NotDelivered | QuietAsk>;
    readonly ask: (
      to: string,
      body: string,
      timeout?: Duration.Input,
      options?: AskOptions
    ) => Effect.Effect<Asked, NotDelivered | AskFailed | QuietAsk>;
    readonly reply: (
      id: string,
      body: string | LexiconRecordValue,
      options?: Pick<
        SendOptions,
        | "ccOnPurpose"
        | "encrypt"
        | "kind"
        | "onDispatch"
        | "onPhase"
        | "quiet"
        | "summary"
      > & {
        readonly replyAll?: boolean;
        readonly to?: string | undefined;
      }
    ) => Effect.Effect<Delivered, NotDelivered | AskFailed | QuietAsk>;
    readonly handled: (
      id: string
    ) => Effect.Effect<Delivered | HandledAck, NotDelivered | AskFailed>;
    readonly pending: Effect.Effect<readonly Received[]>;
    readonly list: Effect.Effect<readonly Listed[]>;
    readonly retire: (
      successor: Option.Option<string>
    ) => Effect.Effect<Retire.OutputValue, NotDelivered>;
    readonly status: Effect.Effect<Status>;
  }
>()("pi-ratking/RatKing") {}

export class Inbox extends Context.Service<
  Inbox,
  {
    readonly attach: (name: string) => Effect.Effect<Attached, NotDelivered>;
    readonly hold: (
      deliver: HeldDelivery,
      options: HoldOptions
    ) => Effect.Effect<void, NotDelivered | LeaseHeld>;
    readonly holder: Effect.Effect<Option.Option<LeaseHolder>, NotDelivered>;
    readonly change: (
      change: AttentionChange
    ) => Effect.Effect<AttentionValue, NotDelivered>;
    readonly levers: Effect.Effect<AttentionSnapshot, NotDelivered>;
    readonly locate: (name: string) => Effect.Effect<Located, NotDelivered>;
    readonly peek: (options?: PeekOptions) => Effect.Effect<Peek, NotDelivered>;
    readonly statusOf: (
      name: string
    ) => Effect.Effect<AttentionStatus.MainValue, NotDelivered>;
  }
>()("ratking-client/Inbox") {}

const Cursor = Schema.Struct({ afterSeq: Schema.Int });

const SavedLease = Schema.Struct({
  did: Schema.String,
  generation: Schema.Int,
  leaseId: Schema.String,
});

const peersOf = (documents: readonly PeerDocument[]) => [
  ...new Map(documents.map((document) => [document.id, document])).values(),
];

const instant = (millis: number) => DateTime.makeUnsafe(millis);

const unsettled = (event: Defs.MessageEventValue) =>
  event.receipt.state !== "acked" &&
  event.receipt.state !== "expired" &&
  event.receipt.state !== "failed";

const custodyOf = (message: OpenedMessage) => {
  const custody: Pick<
    Inbound,
    "delegatedFor" | "delegatedTo" | "originalId" | "via"
  > = {};

  if (message.via !== undefined) {
    Object.assign(custody, { via: message.via });
  }

  if (message.delegatedTo !== undefined) {
    Object.assign(custody, { delegatedTo: message.delegatedTo });
  }

  if (message.delegatedFor !== undefined) {
    Object.assign(custody, {
      delegatedFor: message.delegatedFor,
      originalId: message.originalId,
    });
  }

  return custody;
};

const persistenceError = (error: { readonly _tag: string }) =>
  new NotDelivered({
    code: "NotAttempted",
    reason: `Relay journal: ${reasonOf(error)}`,
  });

export const makeRatKing = Effect.gen(function* makeRatKing() {
  const settings = yield* Settings;
  const lifetime = yield* Effect.scope;
  const directory = yield* Directory;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const store = yield* SecretStore;
  const issuer = yield* Issuer;
  const threads = yield* Threads;

  const replyFor = Effect.fn("RatKing.replyRef")(function* replyFor(
    parent: SendOptions["replyTo"]
  ) {
    if (parent === undefined) {
      return Option.none();
    }

    const stored = yield* threads.lookup(parent.messageId);

    return Option.some(
      Option.match(stored, {
        onNone: () => replyRef(parent.messageId),
        onSome: (record) =>
          replyRef(parent.messageId, record.reply?.root ?? record.thread),
      })
    );
  });

  const asks = yield* Deferred.make<AsksApi<NotDelivered>>();

  const state = yield* Ref.make<ReaderState>(
    ReaderState.Starting({ reason: "Rat King is starting" })
  );

  const health = yield* Ref.make({
    lastConsumeOk: Option.none<number>(),
    lastError: Option.none<string>(),
    leaseHeldSince: Option.none<number>(),
  });

  const session = yield* Ref.make(Option.none<SessionFacts>());
  const claimGate = yield* Ref.make(Option.none<Deferred.Deferred<boolean>>());

  const leaseHealth = yield* Ref.make({
    acquisitionSince: 0,
    generation: 0,
    leaseUntil: Option.none<string>(),
  });

  const heartbeat = yield* Ref.make(
    Option.none<{ readonly name: string; readonly startedAt: number }>()
  );

  const retries = yield* Ref.make(emptyRetries());

  const retryMetric = (name: string) => (event: RetryEvent) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.update(retries, (current) => countRetry(current, name, event, now))
      )
    );

  const beatLock = yield* Semaphore.make(1);
  let closing = false;

  const attempts = yield* Ref.make(0);
  const self = yield* Deferred.make<Self, NotDelivered>();
  const established = yield* Ref.make(Option.none<Self>());
  const nameBar = yield* Ref.make(Option.none<string>());
  const fence = yield* Ref.make(Option.none<LeaseFence>());
  const adopting = yield* Ref.make(false);
  const attached = yield* Ref.make(false);
  const lastLease = yield* Ref.make(Option.none<LeaseFence>());

  const heldSince = yield* Ref.make(Option.none<number>());

  const front = yield* Ref.make(Option.none<FrontLoops>());
  const seen = recentMap<string, true>(4096);
  const acknowledgments = new Map<string, MessageMeta["ack"]>();

  const displayAck = (id: string) =>
    acknowledgments.get(id)?.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          acknowledgments.delete(id);
        })
      ),
      Effect.catchTag("MailboxClientError", (failure) =>
        Effect.logWarning("Rat King display acknowledgment failed", failure)
      )
    );

  const relayed = new Map<string, string>();

  const consumeAck = (id: string) =>
    (displayAck(id) ?? Effect.void).pipe(Effect.forkIn(lifetime));

  const presences = recentMap<
    string,
    { readonly at: number; readonly value: Option.Option<PresenceValue> }
  >(1024);

  const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Settings, settings),
      Effect.provideService(Directory, directory),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(SecretStore, store),
      Effect.provideService(Issuer, issuer)
    );

  const cursorFile = (name: string) =>
    path.join(settings.state, "cursors", `${provisionLabel(name)}.json`);

  const leaseFile = (name: string) =>
    path.join(settings.state, "leases", `${provisionLabel(name)}.json`);

  const readLease = (name: string, did: string) =>
    fs
      .readFileString(leaseFile(name))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(SavedLease))
        ),
        Effect.option,
        Effect.map(Option.filter((saved) => saved.did === did))
      );

  const writeLease = (name: string, saved: LeaseFence) =>
    Schema.encodeEffect(Schema.fromJsonString(SavedLease))(saved).pipe(
      Effect.flatMap((json) => writePrivateJson(leaseFile(name), json)),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tapError(() => Effect.logWarning("Rat King lease not saved")),
      Effect.ignore
    );

  const readCursor = (name: string) =>
    fs.readFileString(cursorFile(name)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))),
      Effect.map((cursor) => cursor.afterSeq),
      Effect.option
    );

  const heartbeatFile = (name: string) =>
    path.join(settings.state, "readers", `${provisionLabel(name)}.json`);

  const retryHeartbeatFile = (pid: number) =>
    path.join(settings.state, "readers", "retries", `${pid}.json`);

  const readHeartbeat = (name: string) =>
    fs
      .readFileString(heartbeatFile(name))
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(HeartbeatJson)),
        Effect.option
      );

  const publish = beatLock
    .withPermits(1)(
      Effect.gen(function* publishHeartbeat() {
        const beat = yield* Ref.get(heartbeat);
        const facts = yield* Ref.get(session);

        if (closing || Option.isNone(beat) || Option.isNone(facts)) {
          return;
        }

        const now = yield* Clock.currentTimeMillis;
        const reader = yield* Ref.get(state);
        const current = yield* Ref.get(health);
        const lease = yield* Ref.get(leaseHealth);

        const value: ReaderHeartbeatValue = {
          acquisitionSince: instant(lease.acquisitionSince),
          generation: lease.generation,
          lastConsumeOk: current.lastConsumeOk.pipe(
            Option.map(instant),
            Option.getOrNull
          ),
          lastError: Option.getOrNull(current.lastError),
          leaseHeldSince: current.leaseHeldSince.pipe(
            Option.map(instant),
            Option.getOrNull
          ),
          leaseTtlMs: 300_000,
          leaseUntil: lease.leaseUntil.pipe(
            Option.map(DateTime.makeUnsafe),
            Option.getOrNull
          ),
          name: beat.value.name,
          pid: facts.value.pid,
          retries: yield* Ref.get(retries),
          session: facts.value.session,
          startedAt: instant(beat.value.startedAt),
          state: reader._tag,
          updatedAt: instant(now),
        };

        const owner = (facts.value.owner ?? Option.none()).pipe(
          Option.filter(Schema.is(AgentName))
        );

        if (Option.isSome(owner)) {
          Object.assign(value, { owner: owner.value });
        }

        const json = yield* Schema.encodeEffect(HeartbeatJson)(value);

        for (const file of [
          heartbeatFile(beat.value.name),
          retryHeartbeatFile(facts.value.pid),
        ]) {
          const temp = path.join(
            path.dirname(file),
            `.${path.basename(file)}.${facts.value.pid}.tmp`
          );

          yield* fs.makeDirectory(path.dirname(file), {
            mode: 0o700,
            recursive: true,
          });
          yield* fs.writeFileString(temp, json, { mode: 0o600 });
          yield* fs.rename(temp, file);
        }
      })
    )
    .pipe(
      Effect.tapError(() =>
        Effect.logWarning("Rat King reader heartbeat not written")
      ),
      Effect.ignore
    );

  const retireHeartbeat = beatLock.withPermits(1)(
    Effect.gen(function* retireHeartbeat() {
      closing = true;

      const beat = yield* Ref.get(heartbeat);
      const facts = yield* Ref.get(session);

      if (Option.isNone(beat) || Option.isNone(facts)) {
        return;
      }

      const file = heartbeatFile(beat.value.name);

      const written = yield* fs
        .readFileString(file)
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(HeartbeatJson)),
          Effect.option
        );

      if (Option.exists(written, (saved) => saved.pid === facts.value.pid)) {
        yield* fs.remove(file).pipe(Effect.ignore);
      }

      yield* fs.remove(retryHeartbeatFile(facts.value.pid)).pipe(Effect.ignore);
    })
  );

  const setState = (next: ReaderState) =>
    Ref.set(state, next).pipe(
      Effect.andThen(Ref.get(session)),
      Effect.flatMap((facts) =>
        Effect.try(() => {
          if (Option.isSome(facts)) {
            facts.value.onState?.(next);
          }
        }).pipe(Effect.ignore)
      ),
      Effect.andThen(publish)
    );

  const consumed = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Ref.update(health, (current) => ({
        ...current,
        lastConsumeOk: Option.some(now),
      }))
    )
  );

  const quarantineDir = (name: string) =>
    path.join(settings.state, "quarantine", provisionLabel(name));

  const writeCursor = (name: string, afterSeq: number) =>
    Schema.encodeEffect(Schema.fromJsonString(Cursor))({ afterSeq }).pipe(
      Effect.flatMap((json) => writePrivateJson(cursorFile(name), json)),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tapError(() => Effect.logWarning("Rat King cursor not written")),
      Effect.ignore
    );

  const supervise = <A, E extends { readonly _tag: string }, R>(
    name: Option.Option<string>,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, never, R> =>
    Effect.gen(function* loop() {
      const result = yield* Effect.result(effect);

      if (Result.isSuccess(result)) {
        return result.success;
      }

      const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);

      yield* Ref.update(health, (current) => ({
        ...current,
        lastError: Option.some(errorTag(result.failure)),
      }));

      yield* setState(
        ReaderState.Retrying({
          attempt,
          name,
          reason: reasonOf(result.failure),
        })
      );

      yield* readerRetryDelay(attempt).pipe(Effect.flatMap(Effect.sleep));

      return yield* supervise(name, effect);
    });

  const senderOf = Effect.fn("RatKing.replySender")(function* senderOf(
    record: Received
  ) {
    if (record.via !== undefined) {
      return Option.some(record.via.desk);
    }

    const claimed = Option.liftPredicate(
      record.from,
      (from) =>
        Schema.is(AgentName)(from) &&
        didFor(settings.didTemplate, settings.reserved, from) === record.did
    );

    return Option.orElse(yield* directory.nameOf(record.did), () => claimed);
  });

  const inboundOf = (own: Self, message: OpenedMessage) =>
    Effect.gen(function* decodeInbound() {
      const payload = yield* decodePayload(message.body);

      const known = yield* directory.nameOf(
        message.via?.deskDid ?? message.senderDid
      );

      const claimed =
        message.via?.desk ??
        Option.match(payload, {
          onNone: () => Option.getOrElse(known, () => message.senderDid),
          onSome: (value) => canonicalName(settings.reserved, value.from),
        });

      const verified = verifiedSender({
        claimed,
        did: message.via?.deskDid ?? message.senderDid,
        known,
        reserved: settings.reserved,
        template: settings.didTemplate,
      });

      const inbound: Inbound = {
        ...custodyOf(message),
        body: Option.match(payload, {
          onNone: () => message.body,
          onSome: (value) => value.body,
        }),
        cc:
          message.cc !== undefined ||
          Option.exists(payload, (value) => (value.cc?.length ?? 0) > 0),
        did: message.senderDid,
        from: claimed,
        id: message.tid,
        kind: Option.getOrElse(
          Option.flatMapNullishOr(payload, (value) => value.kind),
          (): KindValue => "message"
        ),
        label: Option.flatMapNullishOr(payload, (value) => value.label),
        replyTo: Option.orElse(
          Option.flatMapNullishOr(
            payload,
            (value) => value.reply?.parent ?? value.replyTo
          ),
          () => Option.fromNullishOr(message.replyTo?.messageId)
        ),
        summary: Option.flatMapNullishOr(payload, (value) => value.summary),
        verified,
      };

      if (settings.attentionLevers === true) {
        Object.assign(inbound, {
          sender: Option.getOrElse(known, () =>
            verified ? claimed : message.senderDid
          ),
        });
      }

      if (Option.isSome(payload)) {
        if (payload.value.quiet !== undefined) {
          Object.assign(inbound, { quiet: payload.value.quiet });
        }

        if (payload.value.reply !== undefined) {
          Object.assign(inbound, { reply: payload.value.reply });
        }

        if (payload.value.cc !== undefined) {
          Object.assign(inbound, { ccNames: payload.value.cc });
        }

        if (payload.value.to !== undefined) {
          const copy =
            message.delegatedFor === undefined &&
            addressedElsewhere(settings.reserved, payload.value.to, own.name);

          Object.assign(inbound, { copy, to: payload.value.to });

          const digest = digestFor(settings.ccDigestMinutes ?? {}, own.name);

          if ((copy || inbound.quiet === true) && Option.isSome(digest)) {
            Object.assign(inbound, { digestMinutes: digest.value });
          }
        }

        if (payload.value.thread !== undefined) {
          Object.assign(inbound, { thread: payload.value.thread });
        }
      }

      return { inbound, payload };
    });

  const intake =
    (own: Self, route: RelayRoute) =>
    (message: OpenedMessage, meta: MessageMeta) =>
      Effect.gen(function* takeIn() {
        const checkpoint = yield* Deferred.make<boolean>();

        if (
          seen.get(message.tid) === undefined &&
          !acknowledgments.has(message.tid)
        ) {
          acknowledgments.set(
            message.tid,
            Deferred.await(checkpoint).pipe(Effect.andThen(meta.ack))
          );
          const { inbound, payload } = yield* inboundOf(own, message);

          const record = Option.isNone(payload)
            ? yield* decodeRecord(message.body)
            : Option.none<LexiconRecordValue>();

          if (Option.isSome(record)) {
            yield* threads.remember(inbound);
            yield* route.record({
              did: inbound.did,
              from: inbound.from,
              id: inbound.id,
              record: record.value,
              replyTo: inbound.replyTo,
              verified: inbound.verified,
            });
          } else {
            const journal = yield* Deferred.await(asks);
            const original = yield* journal.match(inbound);

            if (Option.isSome(original)) {
              Object.assign(inbound, {
                askSummary: original.value.summary,
                copy: false,
                kind: "reply",
              });
              const acknowledgment = acknowledgments.get(inbound.id);

              if (acknowledgment !== undefined) {
                acknowledgments.set(
                  inbound.id,
                  acknowledgment.pipe(
                    Effect.andThen(
                      journal
                        .ack(original.value.id)
                        .pipe(
                          Effect.catchTag("NotDelivered", (failure) =>
                            Effect.logWarning(
                              "Rat King ask acknowledgment not saved",
                              failure
                            )
                          )
                        )
                    )
                  )
                );
              }
            }

            const settled = yield* threads.settle(inbound);

            yield* threads.remember(inbound);

            yield* route.message(
              inbound,
              settled,
              message.encrypted ?? true,
              meta.redelivered
            );
          }

          seen.set(message.tid, true);
        }

        yield* writeCursor(own.name, meta.seq);
        yield* consumed;
        yield* Deferred.succeed(checkpoint, true);
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => acknowledgments.delete(message.tid))
        )
      );

  let consumerStarts = 0;

  const consumeOnce = (
    own: Self,
    facts: SessionFacts,
    route: RelayRoute,
    refreshAttention: AttentionApi["refresh"]
  ) =>
    Effect.gen(function* consumeLease() {
      if (consumerStarts > 0) {
        yield* retryMetric(own.name)("consumeReconnect");
      }

      consumerStarts += 1;
      const acquisitionSince = yield* Clock.currentTimeMillis;
      yield* Ref.update(leaseHealth, (current) => ({
        ...current,
        acquisitionSince,
      }));
      yield* setState(ReaderState.Acquiring({ did: own.did, name: own.name }));

      const handle = yield* ownIdentity(own.identity);

      const client = yield* prepare({
        endpoint: settings.endpoint,
        onRetryMetric: retryMetric(own.name),
        own: handle,
        peers: peersOf(yield* directory.documents),
        serviceDid: settings.serviceDid,
      });

      const saved = yield* readCursor(own.name);

      const afterSeq = Option.isSome(saved) ? saved.value : yield* client.head;

      if (Option.isNone(saved)) {
        yield* writeCursor(own.name, afterSeq);
      }

      const options: ConsumeOptions = {
        ackOnReturn: false,
        afterSeq,
        failOnHeld: true,
        harness: {
          $type: "sh.mschf.ratking.runtime.lease#pi",
          sessionId: facts.session,
        },
        leaseName: own.name,
        onAttentionReceipt: () =>
          refreshAttention.pipe(
            Deadline.timeout("2 seconds"),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Rat King attention refresh failed; retained current levers",
                cause
              )
            )
          ),
        onLease: (lease) =>
          Ref.get(lastLease).pipe(
            Effect.tap((previous) =>
              Effect.sync(() => {
                if (
                  !Option.exists(
                    previous,
                    (held) => held.generation === lease.generation
                  )
                ) {
                  seen.clear();
                  acknowledgments.clear();
                  relayed.clear();
                }
              })
            ),
            Effect.andThen(
              Effect.all([
                Ref.update(leaseHealth, (current) => ({
                  ...current,
                  generation: lease.generation,
                  leaseUntil: Option.some(lease.expiresAt),
                })),
                Ref.set(attempts, 0),
                Ref.set(adopting, false),
                Ref.set(heldSince, Option.none()),
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    Ref.update(health, (current) => ({
                      ...current,
                      lastConsumeOk: Option.some(now),
                      leaseHeldSince: Option.orElseSome(
                        current.leaseHeldSince,
                        () => now
                      ),
                    }))
                  )
                ),
                Ref.set(
                  fence,
                  Option.some({
                    did: own.did,
                    generation: lease.generation,
                    leaseId: lease.leaseId,
                  })
                ),
                Ref.set(
                  lastLease,
                  Option.some({
                    did: own.did,
                    generation: lease.generation,
                    leaseId: lease.leaseId,
                  })
                ),
                writeLease(own.name, {
                  did: own.did,
                  generation: lease.generation,
                  leaseId: lease.leaseId,
                }),
                setState(
                  ReaderState.Live({
                    did: own.did,
                    expiresAt: lease.expiresAt,
                    generation: lease.generation,
                    name: own.name,
                  })
                ),
              ])
            ),
            Effect.asVoid
          ),
        onSkip: ({ messageId, reason, senderDid, seq }) =>
          Effect.logWarning("Rat King skipped a delivery", {
            messageId,
            reason,
            recipient: own.name,
            senderDid,
            seq,
          }).pipe(
            Effect.andThen(writeCursor(own.name, seq)),
            Effect.andThen(consumed)
          ),
        renders: RENDERS,
        unopenable: (event, error) =>
          recover(quarantineDir(own.name), client)(event, error).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path)
          ),
      };

      const savedLease = yield* readLease(own.name, own.did);

      yield* client.consume(
        intake(own, route),
        Option.match(
          Option.orElse(yield* Ref.get(lastLease), () => savedLease),
          {
            onNone: () => options,
            onSome: (resume): ConsumeOptions => ({
              ...options,
              resume: {
                did: resume.did,
                generation: resume.generation,
                leaseId: resume.leaseId,
              },
            }),
          }
        )
      );
    }).pipe(
      Effect.ensuring(
        Effect.all([
          Ref.set(fence, Option.none()),
          Ref.update(health, (current) => ({
            ...current,
            leaseHeldSince: Option.none(),
          })),
        ])
      ),
      Effect.scoped,
      Effect.provideService(HttpClient.HttpClient, http)
    );

  const awaitSelf = Deferred.await(self).pipe(
    Deadline.timeoutOrElse({
      duration: "20 seconds",
      orElse: () =>
        Ref.get(state).pipe(
          Effect.flatMap((reader) =>
            Effect.fail(
              new NotDelivered({
                code: "NoIdentity",
                reason: ReaderState.$match(reader, {
                  Acquiring: () => "Identity not ready",
                  Live: () => "Identity not ready",
                  Minting: ({ name }) => `Still minting ${name}`,
                  Refused: ({ reason }) => reason,
                  Retrying: ({ reason }) => reason,
                  SendOnly: () => "Identity not ready",
                  Starting: ({ reason }) => reason,
                }),
              })
            )
          )
        ),
    })
  );

  const attention = yield* attentionReader(
    settings.attentionLevers === true,
    Effect.gen(function* attentionClient() {
      const own = yield* awaitSelf;

      const client = yield* prepare({
        endpoint: settings.endpoint,
        own: yield* ownIdentity(own.identity),
        peers: [],
        serviceDid: settings.serviceDid,
      });

      return client.mailbox;
    }).pipe(Effect.scoped, Effect.provideService(HttpClient.HttpClient, http))
  );

  const refused = (code: typeof NotDeliveredCode.Type) => (reason: string) =>
    new NotDelivered({ code, reason });

  const foreground = Deadline.timeoutOrElse({
    duration: Deadline.OPERATION_MS,
    orElse: () =>
      Effect.fail(
        refused("Uncertain")(
          "Caller deadline exceeded; admission may have reached the mailbox. Check pending/inbox before resending."
        )
      ),
  });

  const presenceOf = (
    did: string,
    lookup: Effect.Effect<PresenceValue, MailboxClientError>
  ) =>
    Effect.gen(function* presenceLineFor() {
      const now = yield* Clock.currentTimeMillis;
      const cached = presences.get(did);

      const value =
        cached !== undefined && now - cached.at < PRESENCE_TTL_MS
          ? cached.value
          : yield* lookup.pipe(
              Deadline.timeoutOption(yield* PresenceTimeout),
              Effect.orElseSucceed(() => Option.none<PresenceValue>()),
              Effect.tap((fresh) =>
                Effect.sync(() => {
                  presences.set(did, { at: now, value: fresh });
                })
              )
            );

      return value;
    }).pipe(
      Effect.catchCause(() => Effect.succeed(Option.none<PresenceValue>()))
    );

  const lookup = Effect.fn("RatKing.lookup")(function* lookup(
    identity: Parameters<typeof ownIdentity>[0],
    requested: string
  ) {
    const name = canonicalName(settings.reserved, requested);

    if (!Schema.is(AgentName)(name)) {
      return yield* refused("UnknownName")(name);
    }

    const did = didFor(settings.didTemplate, settings.reserved, name);

    const document = yield* Effect.gen(function* fetchDocument() {
      const client = yield* prepare({
        endpoint: settings.endpoint,
        own: yield* ownIdentity(identity),
        peers: [],
        serviceDid: settings.serviceDid,
      });

      return yield* client.refresh(did);
    }).pipe(Effect.scoped, Effect.provideService(HttpClient.HttpClient, http));

    yield* directory.record(name, document).pipe(Effect.ignore);

    return { did, document, name };
  });

  const recalled = (id: string, asker: string): Received => {
    const from = canonicalName(settings.reserved, asker);

    return {
      answered: false,
      ask: true,
      did: didFor(settings.didTemplate, settings.reserved, from),
      from,
      id,
      preview: "",
    };
  };

  const transmit = Effect.fn("RatKing.transmit")(function* transmit<B>(
    to: string,
    body: string | LexiconRecordValue,
    options: SendOptions,
    before: (id: string, did: string) => Effect.Effect<B, NotDelivered>
  ) {
    if (!(yield* Deferred.isDone(self))) {
      yield* reportPhase(options, SendPhase.Identity());
    }

    const own = yield* awaitSelf;

    if (
      !Schema.is(Schema.String)(body) &&
      body.$type === "sh.mschf.agentgraph.turn" &&
      Option.isNone(signedTurn(body, own.name, true))
    ) {
      return yield* refused("NotAttempted")(
        "Turn record must decode and match the signed sender, unless operator"
      );
    }

    const names = [
      ...new Set(
        [to, ...(options.cc ?? [])].map((name) =>
          canonicalName(settings.reserved, name)
        )
      ),
    ];

    const targets: Resolved[] = [];

    const selfWake =
      !Schema.is(Schema.String)(body) &&
      Option.isSome(Schema.decodeUnknownOption(Wake.Main)(body));

    for (const name of names) {
      yield* reportPhase(options, SendPhase.Resolving({ name }));

      const target = yield* directory
        .resolve(name)
        .pipe(
          Effect.catchTag("UnknownName", (error) =>
            lookup(own.identity, name).pipe(
              Effect.mapError(() =>
                refused("UnknownName")(`${error.name}: ${error.reason}`)
              )
            )
          )
        );

      if (
        target.did === own.did &&
        !(selfWake && name === own.name && name === names[0])
      ) {
        return yield* refused("Self")(
          "Cannot message this Pi's own name, including cc"
        );
      }

      if (!targets.some((known) => known.did === target.did)) {
        targets.push(target);
      }
    }

    const [primary] = targets;

    if (primary === undefined) {
      return yield* refused("NotAttempted")("No recipient");
    }

    const addressed = ccLint({
      body: Option.liftPredicate(body, Schema.is(Schema.String)),
      ccOnPurpose: options.ccOnPurpose,
      kind: options.kind,
      names: targets.map((target) => target.name),
      summary: options.summary,
    });

    if (Option.isSome(addressed)) {
      return yield* new NotDelivered({
        addressed: addressed.value,
        code: "AskAimedAtCc",
        reason: ccRefusal(addressed.value),
      });
    }

    const accepted: Admitted[] = [];

    const checkReaders = Effect.fn("RatKing.checkReaders")(
      function* checkReaders(
        type: string,
        presence: (
          did: string
        ) => Effect.Effect<PresenceValue, MailboxClientError>
      ) {
        for (const target of targets) {
          const current = yield* presenceOf(target.did, presence(target.did));

          const reason = readerCannotRender(
            target.name,
            type,
            Option.getOrUndefined(current)
          );

          if (reason !== undefined) {
            return yield* refused("ReaderCannotRender")(reason);
          }
        }

        return yield* Effect.void;
      }
    );

    return yield* Effect.gen(function* sealAndSend() {
      const client = yield* prepare({
        endpoint: settings.endpoint,
        own: yield* ownIdentity(own.identity),
        peers: targets.map((target) => target.document),
        serviceDid: settings.serviceDid,
      });

      const textBody = Match.value(body).pipe(
        Match.when(Match.string, (text) => Option.some(text)),
        Match.orElse(() => Option.none<string>())
      );

      const encrypt =
        options.encrypt ?? (Option.isSome(textBody) ? settings.encrypt : true);

      yield* reportPhase(options, sealingPhase(encrypt));

      const replyTo =
        options.replyTo === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(Schema.toType(Defs.MessageRef))(
              options.replyTo
            );

      const reply = Option.getOrUndefined(yield* replyFor(options.replyTo));

      let json = yield* Match.value(body).pipe(
        Match.when(Match.string, () => Effect.succeed(Option.none<string>())),
        Match.orElse((record) =>
          Schema.encodeEffect(RecordJson)(record).pipe(Effect.map(Option.some))
        )
      );

      const encodeForId = (id: string) => {
        if (Option.isSome(json)) {
          return json.value;
        }

        const payload: PayloadValue = {
          body: Option.getOrElse(textBody, () => ""),
          cc:
            options.copyTo === undefined
              ? targets.slice(1).map((target) => target.name)
              : targets.map((target) => target.name),
          from: own.name,
          thread: options.thread ?? id,
          to: options.copyTo ?? primary.name,
        };

        const label = (own.label?.() ?? Option.none<string>()).pipe(
          Option.map((text) => text.trim().slice(0, 256)),
          Option.filter((text) => text !== "")
        );

        if (Option.isSome(label)) {
          Object.assign(payload, { label: label.value });
        }

        if (options.quiet === true) {
          Object.assign(payload, { quiet: true });
        }

        if (options.kind !== undefined) {
          Object.assign(payload, { kind: options.kind });
        }

        if (reply !== undefined) {
          Object.assign(payload, {
            reply,
            replyTo: reply.parent,
            thread: reply.root,
          });
        }

        const summary = oneLineSummary(options.summary ?? "");

        if (summary !== "") {
          Object.assign(payload, { summary });
        }

        const text = Schema.encodeSync(PayloadJson)(payload);
        json = Option.some(text);

        return text;
      };

      if (options.kind === "data" || Option.isNone(textBody)) {
        const type = recordType(
          Option.getOrElse(json, () => Option.getOrElse(textBody, () => ""))
        );

        yield* checkReaders(type, client.presence);
      }

      const envelopes: Defs.EncryptedEnvelopeValue[] = [];

      for (const target of targets) {
        envelopes.push(
          yield* client.seal(
            target.did,
            encodeForId,
            replyTo === undefined ? { encrypt } : { encrypt, replyTo }
          )
        );
      }

      const [first] = envelopes;

      if (first === undefined) {
        return yield* refused("NotAttempted")("No envelope");
      }

      const extra = yield* before(first.aad.messageId, primary.did);

      yield* reportPhase(options, SendPhase.Sending());
      yield* observed("dispatch", options.onDispatch);

      for (const envelope of envelopes) {
        const target = targets.find(
          (entry) => entry.did === envelope.aad.recipientDid
        );

        if (target === undefined) {
          return yield* refused("NotAttempted")("Missing sealed recipient");
        }

        const intent = wakeIntent(
          options.kind,
          target.name === primary.name,
          options.quiet,
          Option.isNone(textBody),
          options.copyTo !== undefined
        );

        if (options.critical !== undefined) {
          Object.assign(intent, { critical: options.critical });
        }

        const holderFence = (outcome: SendOutcome) =>
          Effect.gen(function* adoptHolder() {
            if (
              !(
                SendOutcomes.$is("Rejected")(outcome) &&
                outcome.error.error === "LeaseMismatch"
              ) ||
              !(yield* Ref.get(adopting))
            ) {
              return outcome;
            }

            const resolved = yield* client
              .resolveLease(own.did)
              .pipe(Effect.option);

            return Option.isNone(resolved)
              ? outcome
              : yield* retryMetric(own.name)("sendRetry").pipe(
                  Effect.andThen(
                    client.send(envelope, {
                      ...intent,
                      fence: {
                        did: own.did,
                        generation: resolved.value.generation,
                        leaseId: resolved.value.leaseId,
                      },
                    })
                  )
                );
          });

        const attempt = (count: number): Effect.Effect<SendOutcome> =>
          Ref.get(fence).pipe(
            Effect.flatMap((held) =>
              Option.match(held, {
                onNone: () =>
                  client
                    .send(envelope, intent)
                    .pipe(Effect.flatMap(holderFence)),
                onSome: (current) =>
                  client.send(envelope, { ...intent, fence: current }),
              })
            ),
            Effect.flatMap((outcome) =>
              (SendOutcomes.$is("Uncertain")(outcome) ||
                (SendOutcomes.$is("Rejected")(outcome) &&
                  outcome.error.error === "LeaseMismatch")) &&
              count < ADMISSION_TRIES
                ? Effect.gen(function* retryAdmission() {
                    const delay = yield* AdmissionBackoff;

                    const pause = delay(count);

                    if (
                      !(yield* Deadline.canAttempt(
                        Deadline.REQUEST_MS,
                        Duration.toMillis(pause)
                      ))
                    ) {
                      return outcome;
                    }

                    yield* reportPhase(
                      options,
                      SendPhase.Retrying({
                        attempt: count + 1,
                        reason: outcome.error.error ?? outcome._tag,
                      })
                    );
                    yield* Effect.sleep(pause);

                    if (!(yield* Deadline.canAttempt(Deadline.REQUEST_MS))) {
                      return outcome;
                    }

                    yield* retryMetric(own.name)("sendRetry");

                    return yield* attempt(count + 1);
                  })
                : Effect.succeed(outcome)
            )
          );

        const outcome = yield* attempt(1);

        const delivered = yield* SendOutcomes.$match(outcome, {
          Accepted: ({ receipt }) =>
            Effect.succeed(
              admissionOf(target, envelope.aad.messageId, receipt)
            ),
          NotAttempted: ({ reason }) =>
            Effect.fail(refused("NotAttempted")(reason)),
          Rejected: ({ error }) =>
            Effect.fail(
              error.error === "Retired"
                ? refused("Retired")(error.reason)
                : refused("Rejected")(
                    `${error.error ?? "Rejected"} (${error.status ?? "4xx"}): ${error.reason}`
                  )
            ),
          Uncertain: ({ error }) =>
            Effect.fail(
              refused("Uncertain")(
                `Admission not confirmed before the retry limit or caller deadline: ${error.reason}`
              )
            ),
        });

        accepted.push(delivered);
      }

      const [admitted] = accepted;

      if (admitted === undefined) {
        return yield* refused("NotAttempted")("No delivery");
      }

      const now = yield* Clock.currentTimeMillis;

      const line = (yield* presenceOf(
        admitted.did,
        client.presence(admitted.did)
      )).pipe(Option.flatMap((presence) => presenceLine(presence, now)));

      const recipients = recipientLevels(
        primary.name,
        targets.slice(1).map((target) => target.name),
        options.kind ?? "message",
        options.quiet
      );

      const delivered: Delivered = Option.match(line, {
        onNone: () => ({ ...admitted, recipients }),
        onSome: (presence) => ({ ...admitted, presence, recipients }),
      });

      const summary = oneLineSummary(options.summary ?? "");

      const sent: Sent = {
        body: Option.getOrElse(textBody, () =>
          Option.getOrElse(json, () => "")
        ),
        cc: targets.slice(1).map((target) => target.name),
        encrypted: encrypt,
        from: own.name,
        kind: options.kind ?? "message",
        replyTo: options.replyTo?.messageId ?? null,
        summary: Option.isSome(textBody) && summary !== "" ? summary : null,
        thread: Option.match(Option.fromNullishOr(reply), {
          onNone: () => options.thread ?? first.aad.messageId,
          onSome: (ref) => ref.root,
        }),
        to: primary.name,
      };

      return { delivered, extra, sent };
    }).pipe(
      Effect.scoped,
      Effect.provideService(HttpClient.HttpClient, http),
      foreground,
      Effect.mapError((error) => {
        if (accepted.length > 0) {
          return refused("Partial")(
            `Accepted by ${accepted.map((entry) => `${entry.to} (id ${entry.id})`).join(", ")}; remaining delivery failed: ${reasonOf(error)}. Do not resend to accepted recipients.`
          );
        }

        return Schema.is(NotDelivered)(error)
          ? error
          : refused("NotAttempted")(reasonOf(error));
      })
    );
  });

  const routing = (
    own: Self,
    deliver: Deliver
  ): Effect.Effect<RelayRoute, NotDelivered, Scope.Scope> =>
    Effect.gen(function* routeReader() {
      const config = settings.relays.find(
        (relay) => relay.name === own.name || relay.to === own.name
      );

      if (config === undefined) {
        return {
          message: (inbound: Inbound, settled: boolean) =>
            deliver(inbound, settled),
          record: (inbound: InboundRecord) => deliver(inbound, false),
        } satisfies RelayRoute;
      }

      if (config.to === own.name) {
        return {
          message: (inbound: Inbound, settled: boolean) =>
            deliver(inbound, settled),
          record: (inbound: InboundRecord) =>
            Effect.gen(function* staffRecord() {
              const accepted = yield* deliverRelay(config, own.name, inbound, {
                deliver: (received, settled) =>
                  Effect.sync(() => {
                    relayed.set(received.id, inbound.id);
                  }).pipe(
                    Effect.andThen(
                      deliver(received, settled, displayAck(inbound.id))
                    )
                  ),
                remember: threads.remember,
              });

              if (!accepted) {
                yield* deliver(inbound, false);
              }
            }),
        } satisfies RelayRoute;
      }

      const scope = yield* Effect.scope;

      const file = path.join(
        settings.state,
        "relay",
        `${provisionLabel(own.name)}.json`
      );

      const relay = yield* openRelay(config, {
        inject: deliver,
        load: fs.exists(file).pipe(
          Effect.flatMap((exists) =>
            exists
              ? fs
                  .readFileString(file)
                  .pipe(
                    Effect.flatMap(
                      Schema.decodeEffect(Schema.fromJsonString(RelayJournal))
                    )
                  )
              : Effect.succeed([])
          ),
          Effect.mapError(persistenceError)
        ),
        now: Clock.currentTimeMillis,
        save: (entries) =>
          Schema.encodeEffect(Schema.fromJsonString(RelayJournal))(
            entries
          ).pipe(
            Effect.flatMap((json) => writePrivateJson(file, json)),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.mapError(persistenceError)
          ),
      });

      for (const original of yield* relay.originals) {
        if (Option.isNone(yield* threads.lookup(original.id))) {
          yield* threads.remember(original);
        }
      }

      yield* Ref.set(front, Option.some(relay));
      yield* Effect.addFinalizer(() => Ref.set(front, Option.none()));

      const recoverRelay = Clock.currentTimeMillis.pipe(
        Effect.flatMap(relay.recover)
      );

      yield* recoverRelay;
      yield* recoverRelay.pipe(
        Effect.tapError(() =>
          Effect.logWarning("Rat King relay recovery failed")
        ),
        Effect.ignore,
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.forkIn(scope)
      );

      return {
        message: (inbound, settled, encrypted, redelivered) =>
          Effect.gen(function* routeMessage() {
            if (inbound.noReply === true || inbound.askSummary !== undefined) {
              yield* deliver(inbound, settled);

              return;
            }

            const record = yield* relay.receive(
              inbound,
              settled,
              encrypted,
              yield* Clock.currentTimeMillis,
              redelivered
            );

            if (Option.isSome(record)) {
              const send = transmit(
                config.to,
                record.value,
                { encrypt: encrypted },
                () => Effect.void
              );

              const forward =
                config.mode === "copy"
                  ? send
                  : transferCustody(
                      send,
                      relay.forwarded(inbound.id),
                      displayAck(inbound.id) ?? Effect.void
                    );

              yield* forward.pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    "Rat King relay forward failed",
                    error.code
                  ).pipe(Effect.andThen(relay.failed(inbound.id)))
                ),
                Effect.tapError(() =>
                  Effect.logWarning("Rat King relay fallback journal failed")
                ),
                Effect.ignore,
                Effect.forkIn(scope)
              );
            } else if (
              (yield* relay.transferred(inbound.id)) ||
              (yield* relay.closed(inbound.id))
            ) {
              yield* consumeAck(inbound.id);
            }
          }),
        record: (inbound) =>
          Effect.gen(function* routeRecord() {
            const handled = Schema.decodeUnknownOption(RelayHandled)(
              inbound.record
            );

            yield* config.mode === "front" &&
            inbound.verified &&
            inbound.from === config.to &&
            Option.isSome(handled)
              ? relay
                  .handled(handled.value.id)
                  .pipe(Effect.andThen(consumeAck(inbound.id)))
              : deliver(inbound, false);
          }),
      } satisfies RelayRoute;
    });

  const openJournal = (own: Self) => {
    const file = path.join(
      settings.state,
      "asks",
      `${provisionLabel(own.name)}.json`
    );

    return openAsks({
      load: fs.exists(file).pipe(
        Effect.flatMap((exists) =>
          exists
            ? fs
                .readFileString(file)
                .pipe(
                  Effect.flatMap(
                    Schema.decodeEffect(Schema.fromJsonString(AskJournal))
                  )
                )
            : Effect.succeed([])
        ),
        Effect.mapError((failure) =>
          refused("NotAttempted")(`Ask journal: ${reasonOf(failure)}`)
        )
      ),
      now: Clock.currentTimeMillis,
      save: (entries) =>
        Schema.encodeEffect(Schema.fromJsonString(AskJournal))(entries).pipe(
          Effect.flatMap((json) => writePrivateJson(file, json)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((failure) =>
            refused("NotAttempted")(`Ask journal: ${reasonOf(failure)}`)
          )
        ),
    });
  };

  type Prepared = Effect.Success<ReturnType<typeof prepare>>;

  const unreachable = (error: { readonly _tag: string }) =>
    refused("Uncertain")(`Mailbox unreachable: ${reasonOf(error)}`);

  const withClient = <A, E>(
    own: Self,
    peers: readonly PeerDocument[],
    use: (client: Prepared) => Effect.Effect<A, E>
  ) =>
    Effect.gen(function* clientScope() {
      const client = yield* prepare({
        endpoint: settings.endpoint,
        own: yield* ownIdentity(own.identity),
        peers,
        serviceDid: settings.serviceDid,
      });

      return yield* use(client);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HttpClient.HttpClient, http),
      foreground
    );

  const holderOf = (client: Prepared, did: string) =>
    Effect.gen(function* resolveHolder() {
      const found = yield* client.resolveLease(did).pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          (failure) => failure.error === "LeaseNotFound",
          () => Effect.succeed(Option.none<Lease.MainValue>())
        )
      );

      const now = yield* Clock.currentTimeMillis;

      return found.pipe(
        Option.map((lease): LeaseHolder => ({
          expiresAt: lease.expiresAt,
          generation: lease.generation,
          harness: lease.harness.$type.split("#")[1] ?? lease.harness.$type,
          live: Date.parse(lease.expiresAt) > now,
          session: Schema.is(Schema.String)(lease.harness.sessionId)
            ? lease.harness.sessionId
            : UNIDENTIFIED,
        }))
      );
    });

  const waitForClaim = (name: string, retrying = false) =>
    Effect.gen(function* awaitClaim() {
      const gate = yield* Deferred.make<boolean>();

      yield* Ref.set(adopting, true);
      yield* Ref.set(claimGate, Option.some(gate));
      yield* setState(ReaderState.SendOnly({ name, reason: heldReason(name) }));
      yield* Effect.logWarning(
        `Rat King ${name}: ${heldReason(name)}; use claim to retry now`
      );
      yield* retrying ? parkUntilClaimOrRetry(gate) : Deferred.await(gate);
      yield* Ref.set(claimGate, Option.none());
    });

  const awaitGate = (name: string, gatePath: string, sessionId: string) =>
    Effect.gen(function* holdForGate() {
      const reason = `${name}: waiting for the restart gate before claiming the lease`;

      yield* Ref.set(adopting, true);
      yield* setState(ReaderState.SendOnly({ name, reason }));
      yield* Effect.logInfo(`Rat King ${reason}`);
      yield* awaitRestartGate(gatePath, sessionId).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path)
      );
    });

  const awaitSuccession = (name: string, startedAt: number) =>
    Effect.gen(function* awaitParentRelease() {
      const now = yield* Clock.currentTimeMillis;

      if (now - startedAt > SUCCESSION_WINDOW_MS) {
        return yield* waitForClaim(name, true);
      }

      yield* setState(
        ReaderState.SendOnly({
          name,
          reason: `${name}: waiting for the session this one succeeds to release the lease`,
        })
      );

      return yield* successionRetryDelay.pipe(Effect.flatMap(Effect.sleep));
    });

  const liveRival = Effect.gen(function* resolveRival() {
    const own = yield* Ref.get(established);
    const facts = yield* Ref.get(session);

    if (Option.isNone(own) || Option.isNone(facts)) {
      return Option.none<LeaseHolder>();
    }

    const found = yield* withClient(own.value, [], (client) =>
      holderOf(client, own.value.did)
    ).pipe(Effect.orElseSucceed(() => Option.none<LeaseHolder>()));

    return found.pipe(
      Option.filter((held) => held.live && held.session !== facts.value.session)
    );
  });

  const locate = Effect.fn("RatKing.locate")(function* locate(
    requested: string
  ) {
    const name = canonicalName(settings.reserved, requested);

    if (!Schema.is(AgentName)(name)) {
      return yield* refused("UnknownName")(
        `${requested} is not a valid Rat King name`
      );
    }

    const secret = secretName(name);

    const held = yield* store
      .exists(secret)
      .pipe(Effect.mapError((error) => refused("NoIdentity")(error.reason)));

    return {
      did: didFor(settings.didTemplate, settings.reserved, name),
      held,
      name,
      secret,
    } satisfies Located;
  });

  const attach = Effect.fn("RatKing.attach")(function* attach(
    requested: string
  ) {
    const located = yield* locate(requested);

    if (!located.held) {
      return yield* refused("NoIdentity")(
        `This machine holds no key for ${located.name} (secret ${located.secret})`
      );
    }

    const identity = yield* ensureIdentity(located.name).pipe(
      services,
      Effect.mapError((error) => refused("NoIdentity")(reasonOf(error)))
    );

    const own: Self = { did: identity.did, identity, name: located.name };
    const journal = yield* openJournal(own);

    yield* Deferred.succeed(asks, journal);
    yield* Ref.set(established, Option.some(own));
    yield* Ref.set(adopting, true);
    yield* Ref.set(attached, true);
    yield* Deferred.succeed(self, own);

    return {
      did: own.did,
      name: own.name,
      secret: located.secret,
    } satisfies Attached;
  });

  const refuseNameless = Effect.gen(function* nameless() {
    const reason = NAMELESS_REASON;

    yield* setState(ReaderState.Refused({ name: "nameless", reason }));
    yield* Deferred.fail(
      self,
      new NotDelivered({ code: "NoIdentity", reason })
    );
  });

  const loop = Effect.fn("RatKing.run")(function* loop(
    facts: SessionFacts,
    deliver: Deliver,
    startedAt: number
  ) {
    if (facts.nameless === true) {
      return yield* refuseNameless;
    }

    const claimed = yield* supervise(
      Option.none(),
      claimName(facts).pipe(services)
    );

    if (settings.refuse.includes(claimed.name)) {
      const reason = `${claimed.name} is held by another reader (refuse list in the Rat King config); no reader started`;

      yield* setState(ReaderState.Refused({ name: claimed.name, reason }));

      return yield* Deferred.fail(
        self,
        new NotDelivered({ code: "Refused", reason })
      ).pipe(Effect.asVoid);
    }

    const barred =
      facts.reads !== false &&
      blockedByAncestor(
        yield* readHeartbeat(claimed.name),
        facts.ancestors?.() ?? [],
        facts.session,
        facts.alive
      );

    if (facts.reads !== false && !barred) {
      yield* Ref.set(heartbeat, Option.some({ name: claimed.name, startedAt }));
    }

    const own = yield* supervise(
      Option.some(claimed.name),
      Effect.gen(function* establish() {
        yield* setState(ReaderState.Minting({ name: claimed.name }));

        const identity = yield* ensureIdentity(claimed.name, facts.parent);

        return {
          did: identity.did,
          identity,
          label: facts.label ?? (() => facts.pane),
          name: claimed.name,
        };
      }).pipe(services)
    );

    const journal = yield* supervise(Option.some(own.name), openJournal(own));

    yield* Deferred.succeed(asks, journal);
    yield* Ref.set(established, Option.some(own));
    yield* Deferred.succeed(self, own);
    yield* attention.refresh.pipe(
      Deadline.timeout("2 seconds"),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Rat King attention unavailable; retained current levers",
          cause
        )
      )
    );

    if (facts.reads === false) {
      yield* Ref.set(adopting, true);

      return yield* setState(
        ReaderState.SendOnly({
          name: own.name,
          reason:
            "Non-interactive Pi: send-only, no reader and no lease. Set RATKING_PRINT_NAME to read a name",
        })
      );
    }

    if (facts.restartGate !== undefined) {
      yield* awaitGate(own.name, facts.restartGate, facts.session);
    }

    if (barred) {
      yield* waitForClaim(own.name);
    }

    const route = yield* supervise(
      Option.some(own.name),
      routing(own, (inbound, settled, ack) =>
        Effect.gen(function* deliverAttention() {
          const levers: Levers = { ...(yield* attention.levers) };
          const owner = facts.owner ?? Option.none<string>();

          if (Option.isSome(owner)) {
            Object.assign(levers, { owner: owner.value });
          }

          yield* deliver(
            { ...inbound, levers },
            settled,
            ack ?? displayAck(inbound.id)
          );

          if (!("record" in inbound) && injects(inbound, settled)) {
            const names = forwardNames(inbound, levers).filter(
              (name) => name !== own.name && name !== inbound.from
            );

            yield* Effect.forEach(
              names,
              (name) =>
                transmit(
                  name,
                  `Forwarded copy from ${inbound.from} (original ${inbound.id}):\n${inbound.body}`,
                  {
                    copyTo: own.name,
                    encrypt: true,
                    thread: inbound.thread ?? inbound.id,
                  },
                  () => Effect.void
                ).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      "Rat King attention forward failed",
                      error
                    )
                  )
                ),
              { discard: true }
            ).pipe(Effect.forkIn(lifetime));
          }
        })
      )
    );

    yield* journal.nudges.pipe(
      Effect.flatMap((overdue) =>
        Effect.forEach(
          overdue,
          (ask) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                deliver(
                  {
                    body: `🐀 no reply from ${ask.to} · ${ask.id.slice(0, 8)} · ${askAge(ask, now)}\nThe ask remains open; a late reply still arrives.`,
                    cc: false,
                    copy: true,
                    did: ask.did,
                    from: ask.to,
                    id: `no-reply:${ask.id}`,
                    kind: "message",
                    label: Option.none(),
                    noReply: true,
                    replyTo: Option.some(ask.id),
                    summary: Option.none(),
                    verified: true,
                  },
                  false
                )
              )
            ),
          { discard: true }
        )
      ),
      Effect.tapError((error) =>
        Effect.logWarning("Rat King ask nudge failed", error)
      ),
      Effect.ignore,
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped
    );

    return yield* supervise(
      Option.some(own.name),
      consumeOnce(own, facts, route, attention.refresh).pipe(
        Effect.andThen(
          Effect.fail(
            new NotDelivered({
              code: "Uncertain",
              reason: "Reader stopped; restarting",
            })
          )
        ),
        Effect.catchIf(
          (error) =>
            Schema.is(MailboxClientError)(error) && error.error === "LeaseHeld",
          () =>
            Effect.all([Ref.get(heldSince), Clock.currentTimeMillis]).pipe(
              Effect.tap(([since, now]) =>
                Option.isSome(since)
                  ? Effect.void
                  : Ref.set(heldSince, Option.some(now))
              ),
              Effect.map(([since, now]) =>
                Option.match(since, {
                  onNone: () => 0,
                  onSome: (first) => now - first,
                })
              ),
              Effect.flatMap((heldFor) =>
                recoverHeld({
                  heldFor,
                  park:
                    facts.successor === true
                      ? awaitSuccession(own.name, startedAt)
                      : waitForClaim(own.name, true),
                  resolve: withClient(own, [], (client) =>
                    holderOf(client, own.did)
                  ).pipe(Effect.mapError(unreachable)),
                  retrying: setState(
                    ReaderState.Acquiring({ did: own.did, name: own.name })
                  ),
                  session: facts.session,
                })
              )
            )
        )
      )
    ).pipe(Effect.forever);
  });

  const run = (facts: SessionFacts, deliver: Deliver) =>
    Effect.gen(function* start() {
      const startedAt = yield* Clock.currentTimeMillis;

      yield* Ref.set(session, Option.some(facts));

      if (facts.disabled === true) {
        return yield* setState(
          ReaderState.SendOnly({
            name: "off",
            reason: "RATKING_NAME=off: no name claim, no reader and no lease",
          })
        );
      }

      if (facts.nameless === true) {
        yield* Ref.set(nameBar, Option.some(NAMELESS_REASON));
      }

      yield* loop(facts, deliver, startedAt).pipe(Effect.forkScoped);
      yield* publish.pipe(
        Effect.repeat(Schedule.spaced(HEARTBEAT_EVERY)),
        Effect.forkScoped
      );

      return yield* Effect.addFinalizer(() => retireHeartbeat);
    });

  const classify = Effect.fn("RatKing.classify")(function* classify(
    own: Self,
    message: OpenedMessage
  ) {
    const { inbound, payload } = yield* inboundOf(own, message);

    const record = Option.isNone(payload)
      ? yield* decodeRecord(message.body)
      : Option.none<LexiconRecordValue>();

    yield* threads.remember(inbound);

    return Option.isSome(record)
      ? ({
          did: inbound.did,
          from: inbound.from,
          id: inbound.id,
          record: record.value,
          replyTo: inbound.replyTo,
          verified: inbound.verified,
        } satisfies InboundRecord)
      : inbound;
  });

  const afterSeqOf = (
    own: Self,
    options:
      | {
          readonly afterSeq?: number | undefined;
          readonly all?: boolean | undefined;
        }
      | undefined
  ) => {
    if (options?.afterSeq !== undefined) {
      return Effect.succeed(options.afterSeq);
    }

    return options?.all === true
      ? Effect.succeed(0)
      : readCursor(own.name).pipe(Effect.map(Option.getOrElse(() => 0)));
  };

  const peek = Effect.fn("RatKing.peek")(function* peek(options?: PeekOptions) {
    const own = yield* awaitSelf;
    const afterSeq = yield* afterSeqOf(own, options);

    return yield* withClient(
      own,
      peersOf(yield* directory.documents),
      (client) =>
        Effect.gen(function* listInbox() {
          const batch = yield* client.mailbox.poll(afterSeq);
          const messages: Peeked[] = [];
          const unreadable: Unreadable[] = [];

          for (const event of batch.events) {
            if (
              !Schema.is(Defs.MessageEvent)(event) ||
              (options?.all !== true && !unsettled(event))
            ) {
              continue;
            }

            const opened = yield* client
              .open(event.envelope, event.receipt)
              .pipe(
                Effect.catch((error) =>
                  client.refresh(event.envelope.aad.senderDid).pipe(
                    Effect.andThen(client.open(event.envelope, event.receipt)),
                    Effect.mapError((retry) => ({ error, retry }))
                  )
                ),
                Effect.result
              );

            if (Result.isFailure(opened)) {
              unreadable.push({
                id: event.receipt.message.messageId,
                reason: opened.failure.error.reason,
                senderDid: event.envelope.aad.senderDid,
                seq: event.seq,
              });

              continue;
            }

            messages.push({
              encrypted: opened.success.encrypted ?? true,
              received: yield* classify(own, opened.success),
              redelivered: event.receipt.state === "delivered",
              seq: event.seq,
              state: event.receipt.state,
            });
          }

          const result: Peek = {
            messages,
            throughSeq: batch.throughSeq,
            unreadable,
          };

          if (batch.hasMore === true) {
            Object.assign(result, { hasMore: true });
          }

          return result;
        })
    ).pipe(
      Effect.mapError((error) =>
        Schema.is(NotDelivered)(error) ? error : unreachable(error)
      )
    );
  });

  const holder = Effect.gen(function* currentHolder() {
    const own = yield* awaitSelf;

    return yield* withClient(own, [], (client) => holderOf(client, own.did));
  }).pipe(
    Effect.mapError((failure) =>
      Schema.is(NotDelivered)(failure) ? failure : unreachable(failure)
    )
  );

  const hold = Effect.fn("RatKing.hold")(function* hold(
    deliver: HeldDelivery,
    options: HoldOptions
  ) {
    const own = yield* awaitSelf;

    if (
      settings.relays.some(
        (relay) => relay.name === own.name || relay.to === own.name
      )
    ) {
      return yield* refused("NotAttempted")(
        `${own.name} is a relay name; its Pi reader owns consumption`
      );
    }

    const afterSeq = yield* afterSeqOf(own, { afterSeq: options.afterSeq });

    return yield* withClient(
      own,
      peersOf(yield* directory.documents),
      (client) =>
        Effect.gen(function* holding() {
          const now = yield* Clock.currentTimeMillis;

          const harness = {
            $type: "sh.mschf.ratking.runtime.lease#other",
            kind: "ratking-cli",
            sessionId: options.session,
          } as const;

          const taken = yield* client.mailbox.lease
            .acquire({
              did: own.did,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 300_000)),
              harness,
              renders: RENDERS,
            })
            .pipe(
              Effect.catchIf(
                (failure) => failure.error === "LeaseHeld",
                (failure) =>
                  holderOf(client, own.did).pipe(
                    Effect.flatMap((found) =>
                      Effect.fail(
                        new LeaseHeld({
                          expiresAt: Option.match(found, {
                            onNone: () => "unknown",
                            onSome: (value) => value.expiresAt,
                          }),
                          harness: Option.match(found, {
                            onNone: () => "unknown",
                            onSome: (value) => value.harness,
                          }),
                          holder: Option.match(found, {
                            onNone: () => "unknown",
                            onSome: (value) => value.session,
                          }),
                          name: own.name,
                          reason: failure.reason,
                        })
                      )
                    )
                  )
              )
            );

          const held: LeaseFence = {
            did: own.did,
            generation: taken.generation,
            leaseId: taken.leaseId,
          };

          const release = client.mailbox.lease
            .release(held)
            .pipe(Effect.ignore);

          const batch = yield* client.mailbox
            .poll(afterSeq)
            .pipe(Effect.tapError(() => release));

          const backlog = new Set<string>(
            batch.events
              .filter(Schema.is(Defs.MessageEvent))
              .filter(unsettled)
              .map((event) => event.receipt.message.messageId)
          );

          if (backlog.size === 0) {
            return yield* release;
          }

          const done = yield* Deferred.make<boolean>();

          const settle = (id: string) =>
            Effect.suspend(() => {
              backlog.delete(id);

              return backlog.size === 0
                ? Deferred.succeed(done, true)
                : Effect.void;
            });

          const consuming = client.consume(
            (message, meta) =>
              Effect.gen(function* showHeld() {
                yield* deliver(
                  {
                    encrypted: message.encrypted ?? true,
                    received: yield* classify(own, message),
                    redelivered: meta.redelivered,
                    seq: meta.seq,
                    state: meta.redelivered ? "delivered" : "accepted",
                  },
                  meta.ack.pipe(Effect.mapError(unreachable))
                );
                yield* settle(message.tid);
              }),
            {
              ackOnReturn: false,
              afterSeq,
              harness,
              onSkip: ({ messageId }) => settle(messageId),
              renders: RENDERS,
              resume: held,
              unopenable: (event, error) =>
                recover(quarantineDir(own.name), client)(event, error).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path)
                ),
            }
          );

          return yield* Effect.raceFirst(consuming, Deferred.await(done)).pipe(
            Effect.ensuring(release)
          );
        })
    ).pipe(
      Effect.mapError((error) =>
        Schema.is(NotDelivered)(error) || Schema.is(LeaseHeld)(error)
          ? error
          : unreachable(error)
      )
    );
  });

  const change = (input: AttentionChange) =>
    attention
      .change(input)
      .pipe(
        Effect.mapError((failure) =>
          Schema.is(NotDelivered)(failure) ? failure : unreachable(failure)
        )
      );

  const levers = Effect.gen(function* currentLevers() {
    yield* attention.refresh;

    const current = yield* attention.levers;

    if (current.prefs === undefined || current.status === undefined) {
      return yield* refused("Uncertain")(
        "Attention levers did not load from the mailbox"
      );
    }

    return {
      enabled: settings.attentionLevers === true,
      prefs: current.prefs,
      status: current.status,
    } satisfies AttentionSnapshot;
  }).pipe(
    Effect.mapError((failure) =>
      Schema.is(NotDelivered)(failure) ? failure : unreachable(failure)
    )
  );

  const statusOf = Effect.fn("RatKing.statusOf")(function* statusOf(
    requested: string
  ) {
    const own = yield* awaitSelf;
    const name = canonicalName(settings.reserved, requested);

    if (!Schema.is(AgentName)(name)) {
      return yield* refused("UnknownName")(
        `${requested} is not a valid Rat King name`
      );
    }

    const did = didFor(settings.didTemplate, settings.reserved, name);

    return yield* withClient(own, [], (client) =>
      client.mailbox.getStatus(did)
    ).pipe(
      Effect.mapError((failure) =>
        Schema.is(NotDelivered)(failure) ? failure : unreachable(failure)
      )
    );
  });

  const awaitReader = Ref.get(state).pipe(
    Effect.flatMap((reader) =>
      ReaderState.$is("Live")(reader)
        ? Effect.void
        : Effect.fail(
            new AskFailed({
              code: "NoReader",
              reason: ReaderState.$is("SendOnly")(reader)
                ? `${reader.reason}; nothing sent`
                : "This Pi's Rat King reader holds no lease, so a reply could not reach it; nothing sent",
            })
          )
    ),
    Effect.retry(
      Schedule.spaced("250 millis").pipe(
        Schedule.upTo({ duration: "30 seconds" }),
        Schedule.while(
          ({ input }: { readonly input: AskFailed }) =>
            !input.reason.startsWith("Non-interactive")
        )
      )
    )
  );

  const awaitLive = Effect.gen(function* checkReader() {
    if (yield* Ref.get(attached)) {
      return;
    }

    yield* awaitReader;
  });

  const copyOut = (delivered: Delivered, sent: Sent) => {
    const config = settings.relays.find((relay) => relay.name === sent.from);

    if (!copiesOutbound(config, sent.from, [sent.to, ...sent.cc])) {
      return Effect.void;
    }

    const record: RelayOutboundValue = {
      $type: "sh.mschf.ratking.relay#outbound",
      body: sent.body,
      cc: sent.cc,
      encrypted: sent.encrypted,
      id: delivered.id,
      kind: sent.kind,
      replyTo: sent.replyTo,
      summary: sent.summary,
      thread: sent.thread,
      to: sent.to,
    };

    return transmit(
      config.to,
      record,
      { encrypt: sent.encrypted, kind: "data" },
      () => Effect.void
    ).pipe(
      Effect.tapError((failure) =>
        Effect.logWarning("Rat King outbound copy failed", failure.code)
      ),
      Effect.ignore,
      Effect.forkIn(lifetime),
      Effect.asVoid
    );
  };

  const closeLoops = (sent: Sent, original?: string) =>
    Ref.get(front).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (relay) =>
            (original === undefined
              ? Effect.void
              : relay.handled(original)
            ).pipe(Effect.andThen(relay.answered([sent.to, ...sent.cc]))),
        })
      ),
      Effect.tapError((failure) =>
        Effect.logWarning("Rat King relay handled journal failed", failure.code)
      ),
      Effect.ignore
    );

  const confirmHandled = Effect.fn("RatKing.confirmHandled")(
    function* confirmHandled(id: string) {
      const record = yield* threads.lookup(id);

      if (Option.isNone(record) || record.value.relay === undefined) {
        const open = relayed.get(id);

        if (open !== undefined && acknowledgments.has(open)) {
          relayed.delete(id);
          yield* consumeAck(open);

          return { acked: true, id } satisfies HandledAck;
        }

        return yield* new AskFailed({
          code: "NoSuchMessage",
          reason: `No relayed message ${id} reached this Pi`,
        });
      }

      const own = yield* awaitSelf;
      const relayName = record.value.relay.name;

      const config = settings.relays.find(
        (relay) => relay.to === own.name && relay.name === relayName
      );

      if (config === undefined) {
        return yield* refused("NotAttempted")(
          "Handled confirmation is available only on the configured EA"
        );
      }

      const target = yield* directory
        .resolve(config.name)
        .pipe(
          Effect.mapError(() => refused("UnknownName")("Relay desk is unknown"))
        );

      if (target.did !== record.value.relay.did) {
        return yield* refused("NotAttempted")(
          "Relay desk DID changed; no confirmation sent"
        );
      }

      const { delivered } = yield* transmit(
        config.name,
        { $type: "sh.mschf.ratking.relay#handled", id },
        { encrypt: record.value.relay.encrypted, kind: "data" },
        () => Effect.void
      );

      yield* threads.answer(id);

      const open = relayed.get(id);

      if (open !== undefined) {
        relayed.delete(id);
        yield* consumeAck(open);
      }

      return delivered;
    }
  );

  const unlessBarred = Ref.get(nameBar).pipe(
    Effect.flatMap((reason) =>
      Option.isSome(reason)
        ? Effect.fail(refused("NoIdentity")(reason.value))
        : Effect.void
    )
  );

  const ratking = RatKing.of({
    ask: Effect.fn("RatKing.ask")(function* ask(to, body, timeout, options) {
      const bound = Duration.millis(
        Math.min(
          600_000,
          Math.max(
            1,
            Duration.toMillis(Duration.fromInputUnsafe(timeout ?? "10 minutes"))
          )
        )
      );

      let receipt: Delivered | undefined;

      return yield* Effect.gen(function* askWithinBudget() {
        yield* unlessBarred;

        if (options?.quiet === true) {
          return yield* quietAsk();
        }

        if (!(yield* Ref.get(attached))) {
          yield* reportPhase(options, SendPhase.Reader());
        }

        yield* awaitLive;

        const pending = yield* Ref.make(Option.none<string>());
        const journal = yield* Deferred.await(asks);

        return yield* Effect.gen(function* askAndWait() {
          const { delivered, extra, sent } = yield* transmit(
            to,
            body,
            { ...options, kind: "ask" },
            (id, did) =>
              Effect.gen(function* registerAsk() {
                const entry: PendingAskValue = {
                  did,
                  id,
                  sentAt: yield* Clock.currentTimeMillis,
                  state: "pending",
                  summary: oneLineSummary(options?.summary ?? body),
                  to: canonicalName(settings.reserved, to),
                };

                if (options?.dueBy !== undefined) {
                  Object.assign(entry, { dueBy: options.dueBy });
                }

                yield* journal.record(entry);
                yield* Ref.set(pending, Option.some(id));

                if (options?.wait !== true) {
                  return Option.none<Deferred.Deferred<Reply>>();
                }

                return Option.some(yield* threads.wait(id, did));
              })
          );

          receipt = delivered;
          yield* observed("delivery", options?.onDelivered);

          yield* copyOut(delivered, sent);
          yield* closeLoops(sent);

          if (Option.isNone(extra)) {
            return { delivered };
          }

          yield* reportPhase(
            options,
            SendPhase.AwaitingReply({ from: delivered.to })
          );

          const reply = yield* Deferred.await(extra.value).pipe(
            Deadline.timeoutOrElse({
              duration: bound,
              orElse: () =>
                Effect.fail(
                  new AskFailed({
                    code: "NoReply",
                    reason: `No reply from ${delivered.to} to ${delivered.id} within ${Duration.format(Duration.fromInputUnsafe(bound))}. The ask was delivered; a late answer arrives as a normal message.${delivered.presence === undefined ? "" : ` ${delivered.presence}`}`,
                  })
                ),
            })
          );

          return { delivered, reply };
        }).pipe(
          Effect.tapError((failure) => {
            if (
              !Schema.is(NotDelivered)(failure) ||
              failure.code === "Partial" ||
              failure.code === "Uncertain"
            ) {
              return Effect.void;
            }

            return Ref.get(pending).pipe(
              Effect.flatMap((id) =>
                Option.match(id, {
                  onNone: () => Effect.void,
                  onSome: (value) =>
                    journal.ack(value).pipe(
                      Effect.tapError((error) =>
                        Effect.logWarning(
                          "Rat King rejected ask not closed",
                          error
                        )
                      ),
                      Effect.ignore
                    ),
                })
              )
            );
          }),
          Effect.ensuring(
            Ref.get(pending).pipe(
              Effect.flatMap((id) =>
                Option.match(id, {
                  onNone: () => Effect.void,
                  onSome: threads.forget,
                })
              )
            )
          )
        );
      }).pipe(
        Deadline.timeoutOrElse({
          duration: options?.wait === true ? bound : Deadline.OPERATION_MS,
          orElse: (): Effect.Effect<never, AskFailed | NotDelivered> =>
            receipt === undefined
              ? Effect.fail(
                  refused("Uncertain")(
                    "Ask deadline exceeded before delivery was confirmed; check pending/inbox before resending."
                  )
                )
              : Effect.fail(
                  new AskFailed({
                    code: "NoReply",
                    reason: `No reply from ${receipt.to} to ${receipt.id} within ${Duration.format(bound)}. The ask was delivered; a late answer arrives as a normal message.`,
                  })
                ),
        })
      );
    }),
    attention: (input) => attention.change(input).pipe(foreground),
    handled: (id) =>
      unlessBarred.pipe(Effect.andThen(confirmHandled(id)), foreground),
    list: Effect.gen(function* list() {
      const remote = yield* issuer.names.pipe(
        Effect.tapError(() =>
          Effect.logWarning("Rat King issuer directory unavailable")
        ),
        Effect.orElseSucceed((): readonly Resolved[] => [])
      );

      const known = new Set((yield* directory.list).map((entry) => entry.name));

      for (const entry of remote) {
        if (
          !known.has(entry.name) &&
          !isReserved(settings.reserved, entry.name) &&
          entry.document.id === entry.did
        ) {
          yield* directory
            .record(entry.name, entry.document, entry.parent)
            .pipe(
              Effect.tapError(() =>
                Effect.logWarning("Rat King directory entry not recorded")
              ),
              Effect.ignore
            );
        }
      }

      return yield* directory.list;
    }).pipe(
      Deadline.timeoutOrElse({
        duration: Deadline.OPERATION_MS,
        orElse: () => directory.list,
      })
    ),
    pending: Effect.gen(function* pendingAsks() {
      if (Option.isNone(yield* Ref.get(established))) {
        return yield* threads.pending;
      }

      const journal = yield* Deferred.await(asks);
      const outbound = yield* journal.pending;

      return [
        ...(yield* threads.pending),
        ...outbound.map((entry): Received => ({
          answered: false,
          ask: true,
          did: entry.did,
          from: entry.to,
          id: entry.id,
          outbound: entry,
          preview: entry.summary,
        })),
      ];
    }),
    reply: Effect.fn("RatKing.reply")(function* reply(id, body, options) {
      yield* unlessBarred;

      if (options?.quiet === true && options.kind === "ask") {
        return yield* quietAsk();
      }

      const stored = yield* threads.lookup(id);

      const record = Option.isSome(stored)
        ? stored
        : Option.map(Option.fromNullishOr(options?.to), (asker) =>
            recalled(id, asker)
          );

      if (Option.isNone(record)) {
        return yield* new AskFailed({
          code: "NoSuchMessage",
          reason: `No message ${id} reached this Pi since its reader started; pass to with the asker's name to answer it as a thread, or use send`,
        });
      }

      const sender = yield* senderOf(record.value);

      if (Option.isNone(sender)) {
        return yield* refused("UnknownName")(
          `Sender ${record.value.did} is not in the Rat King directory`
        );
      }

      const own = yield* awaitSelf;

      const recipients = replyRecipients(
        { ...record.value, from: sender.value },
        own.name,
        options?.replyAll ?? true
      );

      const [target] = recipients;

      if (target === undefined) {
        return yield* refused("Self")("No other thread participant");
      }

      const originalId = record.value.originalId ?? id;

      const replyOptions: SendOptions = {
        ...options,
        cc: recipients.slice(1),
        kind: options?.kind === "data" ? "data" : "reply",
        replyTo: {
          messageId: originalId,
          senderDid: record.value.did,
        },
        thread: record.value.thread ?? originalId,
      };

      if (record.value.relay !== undefined && options?.encrypt === undefined) {
        Object.assign(replyOptions, { encrypt: record.value.relay.encrypted });
      }

      const { delivered, sent } = yield* transmit(
        target,
        body,
        replyOptions,
        () => Effect.void
      );

      yield* copyOut(delivered, sent);
      yield* closeLoops(sent, id);
      yield* threads.answer(id);

      if (
        record.value.relay !== undefined &&
        settings.relays.some(
          (relay) =>
            relay.name === record.value.relay?.name && relay.mode === "front"
        )
      ) {
        yield* confirmHandled(id).pipe(
          Effect.mapError((error) =>
            refused("Partial")(
              `Reply accepted by ${delivered.to} (id ${delivered.id}); handled confirmation failed: ${reasonOf(error)}. Use handled to retry only the confirmation.`
            )
          )
        );
      }

      return delivered;
    }, foreground),
    retire: Effect.fn("RatKing.retire")(function* retire(successor) {
      const own = yield* awaitSelf;

      const input = yield* Schema.decodeUnknownEffect(
        Schema.toEncoded(Runtime.Data)
      )(
        Option.match(successor, {
          onNone: () => ({ name: own.name }),
          onSome: (next) => ({ name: own.name, successor: next }),
        })
      ).pipe(Effect.mapError(() => refused("NotAttempted")("Invalid name")));

      const response = yield* Transport.use((transport) =>
        transport.request({
          input,
          method: "POST",
          nsid: Retire.Method.nsid,
          params: undefined,
        })
      ).pipe(
        Effect.provide(
          transportLayer(
            settings.endpoint,
            `${settings.serviceDid.replace(/#mailbox$/u, "")}#mailbox`,
            own.identity
          )
        ),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError(() =>
          refused("Uncertain")("Name authority is unreachable")
        )
      );

      if (response.status !== 200) {
        const error = Schema.decodeUnknownOption(
          Schema.Struct({
            error: Schema.String,
            message: Schema.optionalKey(Schema.String),
          })
        )(response.body);

        return yield* refused(
          response.status >= 500 ? "Uncertain" : "Rejected"
        )(
          Option.match(error, {
            onNone: () => `Name authority answered HTTP ${response.status}`,
            onSome: (body) =>
              body.message === undefined || body.message === body.error
                ? body.error
                : `${body.error}: ${body.message}`,
          })
        );
      }

      return yield* Schema.decodeUnknownEffect(Retire.Output)(
        response.body
      ).pipe(
        Effect.mapError(() =>
          refused("Uncertain")("Name authority answered with an invalid body")
        )
      );
    }, foreground),
    run,
    send: Effect.fn("RatKing.send")(function* send(to, body, options) {
      if (options?.quiet === true && options.kind === "ask") {
        return yield* quietAsk();
      }

      const { delivered, sent } = yield* transmit(
        to,
        body,
        options ?? {},
        () => Effect.void
      );

      yield* copyOut(delivered, sent);
      yield* closeLoops(sent);

      return delivered;
    }, foreground),
    status: Effect.gen(function* status() {
      const current = yield* Ref.get(established);

      const pendingAsks = (yield* Deferred.isDone(asks))
        ? yield* (yield* Deferred.await(asks)).pending
        : [];

      return {
        endpoint: settings.endpoint,
        openAsks: pendingAsks.filter(
          (ask) => ask.state === "pending" || ask.state === "nudged"
        ).length,
        quarantine: yield* Option.match(current, {
          onNone: () =>
            Effect.succeed<Quarantined>({ count: 0, latest: Option.none() }),
          onSome: ({ name }) =>
            quarantined(quarantineDir(name)).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path)
            ),
        }),
        reader: yield* Ref.get(state),
        self: current.pipe(Option.map(({ did, name }) => ({ did, name }))),
      };
    }),
  });

  return Context.make(RatKing, ratking).pipe(
    Context.add(
      ReaderControl,
      ReaderControl.of({
        claim: Ref.get(claimGate).pipe(
          Effect.flatMap((gate): Effect.Effect<ClaimOutcome> => {
            if (Option.isNone(gate)) {
              return Effect.succeed(ClaimOutcome.Idle({ gate: "absent" }));
            }

            return liveRival.pipe(
              Effect.flatMap((rival): Effect.Effect<ClaimOutcome> => {
                if (Option.isSome(rival)) {
                  return Effect.succeed(
                    ClaimOutcome.Held({ holder: rival.value })
                  );
                }

                return Deferred.succeed(gate.value, true).pipe(
                  Effect.as(ClaimOutcome.Requested({ gate: "released" }))
                );
              })
            );
          })
        ),
      })
    ),
    Context.add(
      Inbox,
      Inbox.of({
        attach,
        change,
        hold,
        holder,
        levers,
        locate,
        peek,
        statusOf,
      })
    )
  );
});

export const ratKingLayer = Layer.effectContext(makeRatKing).pipe(
  Layer.provide(threadsLayer)
);
