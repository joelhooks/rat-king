/* oxlint-disable eslint/max-classes-per-file, eslint/no-redeclare -- Effect service, Schema errors and the reader state enum share their owning port. */
import * as Defs from "@rat-king/lexicon/defs";
import { ownIdentity, prepare, SendOutcomes } from "@rat-king/mailbox-client";
import type {
  IdentityValue,
  LeaseFence,
  MessageMeta,
  OpenedMessage,
  PeerDocument,
  SendOutcome,
} from "@rat-king/mailbox-client";
import {
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Schedule,
  Schema,
} from "effect";
import type { Scope } from "effect";
import { HttpClient } from "effect/http";

import { Settings } from "./config.ts";
import { Directory, writePrivateJson } from "./directory.ts";
import type { Listed, Resolved } from "./directory.ts";
import { reasonOf } from "./errors.ts";
import { claimName, ensureIdentity } from "./identity.ts";
import type { SessionFacts } from "./identity.ts";
import { Issuer } from "./issuer.ts";
import {
  AgentName,
  canonicalName,
  didFor,
  isReserved,
  provisionLabel,
} from "./name.ts";
import { decodePayload, encodePayload } from "./payload.ts";
import type { Inbound, KindValue, PayloadValue } from "./payload.ts";
import { quarantined, recover } from "./quarantine.ts";
import type { Quarantined } from "./quarantine.ts";
import { SecretStore } from "./secrets.ts";
import { Threads, threadsLayer } from "./threads.ts";
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
]);

export class NotDelivered extends Schema.TaggedError<NotDelivered>()(
  "NotDelivered",
  { code: NotDeliveredCode, reason: Schema.String }
) {}

export class AskFailed extends Schema.TaggedError<AskFailed>()("AskFailed", {
  code: Schema.Literals(["NoReply", "NoReader", "NoSuchMessage"]),
  reason: Schema.String,
}) {}

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
}>;

export const ReaderState = Data.taggedEnum<ReaderState>();

export interface Self {
  readonly name: string;
  readonly did: string;
  readonly identity: IdentityValue;
  readonly label?: () => Option.Option<string>;
}

export interface Delivered {
  readonly id: string;
  readonly seq: number;
  readonly to: string;
  readonly did: string;
}

export interface SendOptions {
  readonly encrypt?: boolean;
  readonly kind?: KindValue;
  readonly replyTo?: { readonly messageId: string; readonly senderDid: string };
}

export type Deliver = (
  inbound: Inbound,
  settled: boolean
) => Effect.Effect<void>;

export interface Status {
  readonly reader: ReaderState;
  readonly self: Option.Option<{ readonly name: string; readonly did: string }>;
  readonly endpoint: string;
  readonly quarantine: Quarantined;
}

export class RatKing extends Context.Service<
  RatKing,
  {
    readonly run: (
      facts: SessionFacts,
      deliver: Deliver
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly send: (
      to: string,
      body: string,
      options?: SendOptions
    ) => Effect.Effect<Delivered, NotDelivered>;
    readonly ask: (
      to: string,
      body: string,
      timeout: Duration.Input,
      options?: Pick<SendOptions, "encrypt">
    ) => Effect.Effect<
      { readonly delivered: Delivered; readonly reply: Reply },
      NotDelivered | AskFailed
    >;
    readonly reply: (
      id: string,
      body: string,
      options?: Pick<SendOptions, "encrypt">
    ) => Effect.Effect<Delivered, NotDelivered | AskFailed>;
    readonly pending: Effect.Effect<readonly Received[]>;
    readonly list: Effect.Effect<readonly Listed[]>;
    readonly status: Effect.Effect<Status>;
  }
>()("pi-ratking/RatKing") {}

const Cursor = Schema.Struct({ afterSeq: Schema.Int });

const peersOf = (documents: readonly PeerDocument[]) => [
  ...new Map(documents.map((document) => [document.id, document])).values(),
];

const backoff = (attempt: number) =>
  Duration.millis(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));

export const makeRatKing = Effect.gen(function* makeRatKing() {
  const settings = yield* Settings;
  const directory = yield* Directory;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const store = yield* SecretStore;
  const issuer = yield* Issuer;
  const threads = yield* Threads;

  const state = yield* Ref.make<ReaderState>(
    ReaderState.Starting({ reason: "Rat King is starting" })
  );

  const attempts = yield* Ref.make(0);
  const self = yield* Deferred.make<Self, NotDelivered>();
  const established = yield* Ref.make(Option.none<Self>());
  const fence = yield* Ref.make(Option.none<LeaseFence>());
  const seen = new Set<string>();

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

  const readCursor = (name: string) =>
    fs.readFileString(cursorFile(name)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))),
      Effect.map((cursor) => cursor.afterSeq),
      Effect.option
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

      yield* Ref.set(
        state,
        ReaderState.Retrying({
          attempt,
          name,
          reason: reasonOf(result.failure),
        })
      );

      yield* Effect.sleep(backoff(attempt));

      return yield* supervise(name, effect);
    });

  const intake =
    (own: Self, deliver: Deliver) =>
    (message: OpenedMessage, meta: MessageMeta) =>
      Effect.gen(function* takeIn() {
        if (!seen.has(message.tid)) {
          seen.add(message.tid);

          const payload = yield* decodePayload(message.body);
          const known = yield* directory.nameOf(message.senderDid);

          const claimed = Option.match(payload, {
            onNone: () => Option.getOrElse(known, () => message.senderDid),
            onSome: (value) => canonicalName(settings.reserved, value.from),
          });

          const verified =
            Option.exists(known, (name) => name === claimed) ||
            (Schema.is(AgentName)(claimed) &&
              didFor(settings.didTemplate, settings.reserved, claimed) ===
                message.senderDid);

          const inbound: Inbound = {
            body: Option.match(payload, {
              onNone: () => message.body,
              onSome: (value) => value.body,
            }),
            cc: message.cc !== undefined,
            did: message.senderDid,
            from: claimed,
            id: message.tid,
            kind: Option.getOrElse(
              Option.flatMapNullishOr(payload, (value) => value.kind),
              (): KindValue => "message"
            ),
            label: Option.flatMapNullishOr(payload, (value) => value.label),
            replyTo: Option.orElse(
              Option.flatMapNullishOr(payload, (value) => value.replyTo),
              () => Option.fromNullishOr(message.replyTo?.messageId)
            ),
            verified,
          };

          const settled = yield* threads.settle(inbound);

          if (!settled) {
            yield* threads.remember(inbound);
          }

          yield* deliver(inbound, settled);
        }

        yield* writeCursor(own.name, meta.seq);
      });

  const consumeOnce = (own: Self, facts: SessionFacts, deliver: Deliver) =>
    Effect.gen(function* consumeLease() {
      yield* Ref.set(
        state,
        ReaderState.Acquiring({ did: own.did, name: own.name })
      );

      const handle = yield* ownIdentity(own.identity);

      const client = yield* prepare({
        endpoint: settings.endpoint,
        own: handle,
        peers: peersOf(yield* directory.documents),
        serviceDid: settings.serviceDid,
      });

      const saved = yield* readCursor(own.name);

      const afterSeq = Option.isSome(saved) ? saved.value : yield* client.head;

      if (Option.isNone(saved)) {
        yield* writeCursor(own.name, afterSeq);
      }

      yield* client.consume(intake(own, deliver), {
        afterSeq,
        harness: {
          $type: "sh.mschf.ratking.runtime.lease#pi",
          sessionId: facts.session,
        },
        onLease: (lease) =>
          Effect.all([
            Ref.set(attempts, 0),
            Ref.set(
              fence,
              Option.some({
                did: own.did,
                generation: lease.generation,
                leaseId: lease.leaseId,
              })
            ),
            Ref.set(
              state,
              ReaderState.Live({
                did: own.did,
                expiresAt: lease.expiresAt,
                generation: lease.generation,
                name: own.name,
              })
            ),
          ]).pipe(Effect.asVoid),
        onSkip: ({ seq }) => writeCursor(own.name, seq),
        unopenable: (event, error) =>
          recover(quarantineDir(own.name), client)(event, error).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path)
          ),
      });
    }).pipe(
      Effect.ensuring(Ref.set(fence, Option.none())),
      Effect.scoped,
      Effect.provideService(HttpClient.HttpClient, http)
    );

  const loop = Effect.fn("RatKing.run")(function* loop(
    facts: SessionFacts,
    deliver: Deliver
  ) {
    const claimed = yield* supervise(
      Option.none(),
      claimName(facts).pipe(services)
    );

    if (settings.refuse.includes(claimed.name)) {
      const reason = `${claimed.name} is held by another reader (refuse list in the Rat King config); no reader started`;

      yield* Ref.set(
        state,
        ReaderState.Refused({ name: claimed.name, reason })
      );

      return yield* Deferred.fail(
        self,
        new NotDelivered({ code: "Refused", reason })
      ).pipe(Effect.asVoid);
    }

    const own = yield* supervise(
      Option.some(claimed.name),
      Effect.gen(function* establish() {
        yield* Ref.set(state, ReaderState.Minting({ name: claimed.name }));

        const identity = yield* ensureIdentity(claimed.name);

        return {
          did: identity.did,
          identity,
          label: facts.label ?? (() => facts.pane),
          name: claimed.name,
        };
      }).pipe(services)
    );

    yield* Ref.set(established, Option.some(own));
    yield* Deferred.succeed(self, own);

    return yield* supervise(
      Option.some(own.name),
      consumeOnce(own, facts, deliver).pipe(
        Effect.andThen(
          Effect.fail(
            new NotDelivered({
              code: "Uncertain",
              reason: "Reader stopped; restarting",
            })
          )
        )
      )
    ).pipe(Effect.forever);
  });

  const run = (facts: SessionFacts, deliver: Deliver) =>
    loop(facts, deliver).pipe(Effect.forkScoped, Effect.asVoid);

  const awaitSelf = Deferred.await(self).pipe(
    Effect.timeoutOrElse({
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
                  Starting: ({ reason }) => reason,
                }),
              })
            )
          )
        ),
    })
  );

  const refused = (code: typeof NotDeliveredCode.Type) => (reason: string) =>
    new NotDelivered({ code, reason });

  const lookup = Effect.fn("RatKing.lookup")(function* lookup(
    identity: Parameters<typeof ownIdentity>[0],
    name: string
  ) {
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

  const transmit = Effect.fn("RatKing.transmit")(function* transmit<B>(
    to: string,
    body: string,
    options: SendOptions,
    before: (id: string, did: string) => Effect.Effect<B>
  ) {
    const own = yield* awaitSelf;

    const target = yield* directory
      .resolve(to)
      .pipe(
        Effect.catchTag("UnknownName", (error) =>
          lookup(own.identity, to).pipe(
            Effect.mapError(() =>
              refused("UnknownName")(`${error.name}: ${error.reason}`)
            )
          )
        )
      );

    if (target.did === own.did) {
      return yield* refused("Self")("Cannot message this Pi's own name");
    }

    const payload: PayloadValue = { body, from: own.name };

    const label = (own.label?.() ?? Option.none<string>()).pipe(
      Option.map((text) => text.trim().slice(0, 256)),
      Option.filter((text) => text !== "")
    );

    if (Option.isSome(label)) {
      Object.assign(payload, { label: label.value });
    }

    if (options.kind !== undefined) {
      Object.assign(payload, { kind: options.kind });
    }

    if (options.replyTo !== undefined) {
      Object.assign(payload, { replyTo: options.replyTo.messageId });
    }

    const json = yield* encodePayload(payload).pipe(
      Effect.mapError(() => refused("NotAttempted")("Invalid payload"))
    );

    return yield* Effect.gen(function* sealAndSend() {
      const handle = yield* ownIdentity(own.identity);

      const client = yield* prepare({
        endpoint: settings.endpoint,
        own: handle,
        peers: [target.document],
        serviceDid: settings.serviceDid,
      });

      const replyTo =
        options.replyTo === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(Schema.toType(Defs.MessageRef))(
              options.replyTo
            );

      const encrypt = options.encrypt ?? settings.encrypt;

      const envelope = yield* client.seal(
        target.did,
        json,
        replyTo === undefined ? { encrypt } : { encrypt, replyTo }
      );

      const extra = yield* before(envelope.aad.messageId, target.did);

      const attempt = (count: number): Effect.Effect<SendOutcome> =>
        Ref.get(fence).pipe(
          Effect.flatMap((held) =>
            Option.match(held, {
              onNone: () => client.send(envelope),
              onSome: (current) => client.send(envelope, { fence: current }),
            })
          ),
          Effect.flatMap((outcome) =>
            SendOutcomes.$is("Uncertain")(outcome) && count < 3
              ? Effect.sleep(Duration.seconds(count)).pipe(
                  Effect.andThen(attempt(count + 1))
                )
              : Effect.succeed(outcome)
          )
        );

      const outcome = yield* attempt(1);

      const delivered = yield* SendOutcomes.$match(outcome, {
        Accepted: ({ receipt }) =>
          Effect.succeed({
            did: target.did,
            id: envelope.aad.messageId,
            seq: receipt.seq,
            to: target.name,
          }),
        NotAttempted: ({ reason }) =>
          Effect.fail(refused("NotAttempted")(reason)),
        Rejected: ({ error }) =>
          Effect.fail(
            refused("Rejected")(
              `${error.error ?? "Rejected"} (${error.status ?? "4xx"}): ${error.reason}`
            )
          ),
        Uncertain: ({ error }) =>
          Effect.fail(
            refused("Uncertain")(
              `Admission not confirmed after 3 tries: ${error.reason}`
            )
          ),
      });

      return { delivered, extra };
    }).pipe(
      Effect.scoped,
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError((error) =>
        Schema.is(NotDelivered)(error)
          ? error
          : refused("NotAttempted")(reasonOf(error))
      )
    );
  });

  const awaitLive = Ref.get(state).pipe(
    Effect.flatMap((reader) =>
      ReaderState.$is("Live")(reader)
        ? Effect.void
        : Effect.fail(
            new AskFailed({
              code: "NoReader",
              reason:
                "This Pi's Rat King reader holds no lease, so a reply could not reach it; nothing sent",
            })
          )
    ),
    Effect.retry(
      Schedule.spaced("250 millis").pipe(
        Schedule.upTo({ duration: "30 seconds" })
      )
    )
  );

  return RatKing.of({
    ask: Effect.fn("RatKing.ask")(function* ask(to, body, timeout, options) {
      yield* awaitLive;

      const pending = yield* Ref.make(Option.none<string>());

      return yield* Effect.gen(function* askAndWait() {
        const { delivered, extra } = yield* transmit(
          to,
          body,
          { ...options, kind: "ask" },
          (id, did) =>
            Ref.set(pending, Option.some(id)).pipe(
              Effect.andThen(threads.wait(id, did))
            )
        );

        const reply = yield* Deferred.await(extra).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new AskFailed({
                  code: "NoReply",
                  reason: `No reply from ${delivered.to} to ${delivered.id} within ${Duration.format(Duration.fromInputUnsafe(timeout))}. The ask was delivered; a late answer arrives as a normal message.`,
                })
              ),
          })
        );

        return { delivered, reply };
      }).pipe(
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
    }),
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
          yield* directory.record(entry.name, entry.document).pipe(
            Effect.tapError(() =>
              Effect.logWarning("Rat King directory entry not recorded")
            ),
            Effect.ignore
          );
        }
      }

      return yield* directory.list;
    }),
    pending: threads.pending,
    reply: Effect.fn("RatKing.reply")(function* reply(id, body, options) {
      const record = yield* threads.lookup(id);

      if (Option.isNone(record)) {
        return yield* new AskFailed({
          code: "NoSuchMessage",
          reason: `No message ${id} reached this Pi; use send instead`,
        });
      }

      const claimed = Option.liftPredicate(
        record.value.from,
        (from) =>
          Schema.is(AgentName)(from) &&
          didFor(settings.didTemplate, settings.reserved, from) ===
            record.value.did
      );

      const sender = Option.orElse(
        yield* directory.nameOf(record.value.did),
        () => claimed
      );

      if (Option.isNone(sender)) {
        return yield* refused("UnknownName")(
          `Sender ${record.value.did} is not in the Rat King directory`
        );
      }

      const { delivered } = yield* transmit(
        sender.value,
        body,
        {
          ...options,
          kind: "reply",
          replyTo: { messageId: id, senderDid: record.value.did },
        },
        () => Effect.void
      );

      yield* threads.answer(id);

      return delivered;
    }),
    run,
    send: Effect.fn("RatKing.send")(function* send(to, body, options) {
      const { delivered } = yield* transmit(
        to,
        body,
        options ?? {},
        () => Effect.void
      );

      return delivered;
    }),
    status: Effect.gen(function* status() {
      const current = yield* Ref.get(established);

      return {
        endpoint: settings.endpoint,
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
});

export const ratKingLayer = Layer.effect(RatKing, makeRatKing).pipe(
  Layer.provide(threadsLayer)
);
