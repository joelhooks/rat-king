import {
  open as openEnvelope,
  plaintext,
  plaintextSuite,
  seal,
  suite,
  EnvelopeFailure,
} from "@rat-king/envelope";
import { openPlaintext } from "@rat-king/envelope/signed";
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import * as Put from "@rat-king/lexicon/admin.putDidDocument";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxClient, clientLayer } from "@rat-king/lexicon/mailbox-client";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as Deliver from "@rat-king/lexicon/mailbox.deliver";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Send from "@rat-king/lexicon/mailbox.send";
import {
  decodeDidKey,
  makeMemoryNonceBinding,
  NonceBinding,
  verifyPass,
} from "@rat-king/lexicon/passes";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import type * as Lease from "@rat-king/lexicon/runtime.lease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import * as Resolve from "@rat-king/lexicon/runtime.resolveLease";
import { Transport } from "@rat-king/lexicon/transport";
import { PublicKey } from "@rat-king/lexicon/trust";
import { signatures } from "@rat-king/lexicon/webcrypto";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { Stream } from "effect";
import type { HttpClient } from "effect/http";

import { attentionClient } from "./attention.ts";
import type { AttentionClient } from "./attention.ts";
import { DidResolver, staticResolver } from "./auth.ts";
import * as Deadline from "./deadline.ts";
import { openDelegated } from "./delegation.ts";
import { clientError, MailboxClientError } from "./error.ts";
import { importSigning, importAgreement } from "./identity.ts";
import type { IdentityValue } from "./identity.ts";
import { PayloadJson } from "./payload.ts";
import { lookupPresence, readerCannotRender } from "./record-visibility.ts";
import type { RetryObserver } from "./retry-metrics.ts";
import { randomTid } from "./tid.ts";
import { transportLayer } from "./transport.ts";
import { watch } from "./watch.ts";

export {
  Identity,
  PrivateJwk,
  importSigning,
  importAgreement,
} from "./identity.ts";

export type { IdentityValue } from "./identity.ts";

export { MailboxClientError } from "./error.ts";

export {
  base64url,
  unbase64url,
  Claims,
  Document,
  Documents,
  documentResolver,
  DidResolver,
  staticResolver,
  serviceToken,
} from "./auth.ts";

export type { ClaimsValue, DocumentsValue } from "./auth.ts";

export { tid } from "./tid.ts";

export { transportLayer } from "./transport.ts";

export { WebSocketPort } from "./watch.ts";

type MutableOpenedMessage = {
  -readonly [K in keyof OpenedMessage]: OpenedMessage[K];
};

interface RawAad {
  messageId: string;
  recipientDid: string;
  recipientKeyId: string;
  senderDid: string;
  expiresAt?: string;
}

interface RawSigningPayload {
  aad: RawAad;
  body: Uint8Array;
  suite: typeof suite | typeof plaintextSuite;
  version: 1;
  replyTo?: Defs.MessageRefValue;
  urgent?: true;
}

interface SealedSendInput {
  critical?: boolean;
  woke: boolean;
  wakeReason: Send.InputValue["wakeReason"];
  envelope: Defs.EncryptedEnvelopeValue;
  generation?: number;
  leaseId?: string;
}

export interface ClientConfig {
  readonly onRetryMetric?: RetryObserver;
  readonly endpoint: string;
  readonly serviceDid: string;
  readonly identity: IdentityValue;
  readonly documents: readonly Defs.DidDocumentValue[];
}

export interface LeaseFence {
  readonly did: string;
  readonly leaseId: string;
  readonly generation: number;
}

export const POLL_MAX_PAGES = 10;

export interface Batch {
  readonly hasMore?: boolean;
  readonly events: List.OutputValue["events"];
  readonly throughSeq: number;
}

export interface OpenedMessage {
  readonly via?: Pick<Defs.ViaValue, "desk" | "deskDid" | "run">;
  readonly delegatedFor?: string;
  readonly delegatedTo?: string;
  readonly originalId?: string;
  readonly senderDid: Defs.AadValue["senderDid"];
  readonly tid: Defs.AadValue["messageId"];
  readonly body: string;
  readonly replyTo?: Defs.MessageRefValue;
  readonly urgent?: true;
  readonly verified: true;
  readonly encrypted?: boolean;
  readonly cc?: {
    readonly senderDid: string;
    readonly messageId: string;
    readonly recipientDid: string;
  };
}

export interface SendOptions {
  readonly critical?: boolean;
  readonly woke?: boolean;
  readonly wakeReason?: Send.InputValue["wakeReason"];
  readonly recordType?: string;
  readonly replyTo?: Defs.MessageRefValue;
  readonly expiresAt?: string;
  readonly fence?: LeaseFence;
  readonly urgent?: true;
  readonly encrypt?: boolean;
}

const decodeBody = (body: Uint8Array) =>
  Effect.try({
    catch: () => new MailboxClientError({ reason: "Invalid UTF-8 body" }),
    try: () =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
  });

const openPass = Effect.fn("RatKingMailbox.openPass")(function* openPass(
  envelope: Defs.EncryptedEnvelopeValue,
  receipt: Defs.ReceiptValue,
  recipientDid: string,
  resolver: typeof DidResolver.Service
) {
  const via = yield* Schema.decodeUnknownEffect(Defs.Via)(receipt.via);

  if (
    via.worker !== envelope.aad.senderDid ||
    via.worker !== receipt.message.senderDid
  ) {
    return yield* new MailboxClientError({
      reason: "Invalid pass sender binding",
    });
  }

  const workerPublicKey = yield* decodeDidKey(via.worker);

  const importPublicKey: (
    format: "jwk",
    key: typeof PublicKey.Type,
    algorithm: { readonly name: "ECDSA"; readonly namedCurve: "P-256" },
    extractable: boolean,
    usages: ["verify"]
  ) => Promise<CryptoKey> = crypto.subtle.importKey.bind(crypto.subtle);

  const workerKey = yield* cryptoOperation(
    importPublicKey.bind(
      crypto.subtle,
      "jwk",
      workerPublicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    )
  );

  const resolveSigningKey = (did: string, keyId: string) =>
    did === via.worker &&
    keyId === `${via.worker}#${via.worker.slice("did:key:".length)}`
      ? Effect.succeed(workerKey)
      : Effect.fail(
          new EnvelopeFailure({ reason: "Unauthorized pass signing key" })
        );

  if (
    receipt.delegatedFor === undefined &&
    (envelope.aad.recipientDid !== recipientDid ||
      envelope.aad.recipientKeyId !== `${recipientDid}#encryption` ||
      receipt.recipientDid !== recipientDid ||
      receipt.message.messageId !== envelope.aad.messageId)
  ) {
    return yield* new MailboxClientError({
      reason: "Invalid pass recipient binding",
    });
  }

  const payload = yield* receipt.delegatedFor === undefined
    ? openPlaintext(envelope, resolveSigningKey)
    : openDelegated(envelope, receipt, recipientDid, resolveSigningKey);

  const content = yield* Schema.decodeUnknownEffect(PayloadJson)(
    yield* decodeBody(payload.body)
  );

  if (content.from !== via.desk) {
    return yield* new MailboxClientError({
      reason: "Invalid pass desk payload",
    });
  }

  const deskKey = yield* resolver.resolve(
    via.deskDid,
    `${via.deskDid}#atproto`,
    "authentication"
  );

  const key = yield* Schema.decodeUnknownEffect(PublicKey)(
    yield* cryptoOperation(
      crypto.subtle.exportKey.bind(crypto.subtle, "jwk", deskKey)
    )
  );

  const recordedAt = Date.parse(receipt.recordedAt ?? "") / 1000;

  const pass = yield* verifyPass(
    {
      grantable: new Set(["rk.send.plain"]),
      issuerScope: ["rk.send.plain"],
      knownDesk: { did: via.deskDid, key, name: via.desk },
    },
    via.pass,
    recordedAt
  ).pipe(
    Effect.provide(signatures),
    Effect.provideService(
      NonceBinding,
      yield* makeMemoryNonceBinding(Effect.succeed(recordedAt))
    )
  );

  if (
    pass.record.worker !== via.worker ||
    pass.record.run !== via.run ||
    !pass.record.scope.includes("rk.send.plain")
  ) {
    return yield* new MailboxClientError({
      reason: "Invalid pass run or scope binding",
    });
  }

  return payload;
});

const openReceived = Effect.fn("RatKingMailbox.openReceived")(
  function* openReceived(
    envelope: Defs.EncryptedEnvelopeValue,
    receipt: Defs.ReceiptValue | undefined,
    identity: IdentityValue,
    resolver: typeof DidResolver.Service
  ) {
    if (receipt?.via !== undefined) {
      return yield* openPass(envelope, receipt, identity.did, resolver);
    }

    const resolveSigningKey = (did: string, keyId: string) =>
      resolver
        .resolve(did, keyId, "authentication")
        .pipe(
          Effect.mapError(
            () =>
              new EnvelopeFailure({ reason: "Unauthorized sender signing key" })
          )
        );

    if (receipt?.delegatedFor !== undefined) {
      return yield* openDelegated(
        envelope,
        receipt,
        identity.did,
        resolveSigningKey
      );
    }

    return yield* openEnvelope({
      envelope,
      recipientDid: identity.did,
      recipientKey: yield* importAgreement(identity),
      recipientKeyId: `${identity.did}#encryption`,
      resolveSigningKey,
    });
  }
);

const sendIntent = (opts: SendOptions | undefined) => {
  const intent: Pick<SealedSendInput, "critical" | "wakeReason" | "woke"> = {
    wakeReason: opts?.wakeReason ?? "to",
    woke: opts?.woke ?? true,
  };

  if (opts?.critical !== undefined) {
    Object.assign(intent, { critical: opts.critical });
  }

  return intent;
};

export interface FencedMessage {
  readonly message: Defs.MessageRefValue;
  readonly leaseId: string;
  readonly generation: number;
}

export interface AcquireRequest {
  readonly did: string;
  readonly harness: Lease.MainValue["harness"];
  readonly renders?: readonly string[];
  readonly expiresAt: string;
  readonly leaseId?: string;
  readonly generation?: number;
}

export class RatKingMailbox extends Context.Service<
  RatKingMailbox,
  {
    readonly getPreferences: AttentionClient["getPreferences"];
    readonly getStatus: AttentionClient["getStatus"];
    readonly putPreferences: AttentionClient["putPreferences"];
    readonly putStatus: AttentionClient["putStatus"];
    readonly send: (
      to: string,
      body: string,
      opts?: SendOptions
    ) => Effect.Effect<Send.OutputValue, MailboxClientError>;
    readonly list: (params: {
      readonly afterSeq?: number;
      readonly cursor?: string;
      readonly limit?: number;
    }) => Effect.Effect<List.OutputValue, MailboxClientError>;
    readonly poll: (
      afterSeq: number
    ) => Effect.Effect<Batch, MailboxClientError>;
    readonly watch: (
      afterSeq: number,
      fence: LeaseFence,
      onRetry?: (error: MailboxClientError) => Effect.Effect<void>
    ) => Stream.Stream<Batch, MailboxClientError>;
    readonly open: (
      envelope: Defs.EncryptedEnvelopeValue,
      receipt?: Defs.ReceiptValue
    ) => Effect.Effect<OpenedMessage, MailboxClientError>;
    readonly deliver: (
      input: FencedMessage
    ) => Effect.Effect<Deliver.OutputValue, MailboxClientError>;
    readonly ack: (
      input: FencedMessage
    ) => Effect.Effect<Ack.OutputValue, MailboxClientError>;
    readonly lease: {
      readonly acquire: (
        input: AcquireRequest
      ) => Effect.Effect<Lease.MainValue, MailboxClientError>;
      readonly renew: (
        input: LeaseFence & {
          readonly expiresAt: string;
          readonly renders?: readonly string[];
        }
      ) => Effect.Effect<Lease.MainValue, MailboxClientError>;
      readonly resolve: (
        did: string
      ) => Effect.Effect<Lease.MainValue, MailboxClientError>;
      readonly release: (
        input: LeaseFence
      ) => Effect.Effect<void, MailboxClientError>;
    };
    readonly putDidDocument: (
      document: Defs.DidDocumentValue
    ) => Effect.Effect<Put.OutputValue, MailboxClientError>;
  }
>()("@rat-king/mailbox-client/RatKingMailbox") {}

export const layer = (
  config: ClientConfig,
  resolverLayer = staticResolver(config.documents)
): Layer.Layer<RatKingMailbox, never, HttpClient.HttpClient> =>
  Layer.effect(
    RatKingMailbox,
    Effect.gen(function* makeMailbox() {
      const client = yield* MailboxClient;
      const transport = yield* Transport;
      const resolver = yield* DidResolver;
      const { identity } = config;

      const list = Effect.fn("RatKingMailbox.list")(
        (params: {
          readonly afterSeq?: number;
          readonly cursor?: string;
          readonly limit?: number;
        }) =>
          Schema.decodeUnknownEffect(Schema.toType(List.Params))({
            ...params,
            recipientDid: identity.did,
          }).pipe(Effect.flatMap(client.list), Effect.mapError(clientError))
      );

      const poll = Effect.fn("RatKingMailbox.poll")(
        function* poll(afterSeq: number) {
          const first = yield* list({ afterSeq, limit: 100 });
          const events = [...first.events];
          let { cursor } = first;
          let pages = 1;
          const cursors = new Set<string>();

          while (cursor !== undefined && pages < POLL_MAX_PAGES) {
            if (cursors.has(cursor)) {
              return yield* new MailboxClientError({
                reason: "Repeated mailbox page cursor",
              });
            }

            cursors.add(cursor);
            const page = yield* list({ afterSeq, cursor, limit: 100 });
            pages += 1;

            if (page.throughSeq !== first.throughSeq) {
              return yield* new MailboxClientError({
                reason: "Snapshot watermark changed during pagination",
              });
            }

            events.push(...page.events);
            ({ cursor } = page);
          }

          if (cursor !== undefined) {
            const last = events.at(-1)?.seq;

            if (
              !Schema.is(Schema.Int)(last) ||
              !Number.isSafeInteger(last) ||
              last <= afterSeq
            ) {
              return yield* new MailboxClientError({
                reason: "Mailbox page did not advance its sequence",
              });
            }

            return { events, hasMore: true, throughSeq: last };
          }

          return { events, throughSeq: first.throughSeq };
        },
        (effect) =>
          effect.pipe(
            Deadline.timeout(Deadline.OPERATION_MS),
            Effect.mapError(clientError)
          )
      );

      return RatKingMailbox.of({
        ...attentionClient(client, identity),
        ack: Effect.fn("RatKingMailbox.ack")((input) =>
          Schema.decodeUnknownEffect(Schema.toType(Ack.Input))({
            ...input,
            recipientDid: identity.did,
          }).pipe(Effect.flatMap(client.ack), Effect.mapError(clientError))
        ),
        deliver: Effect.fn("RatKingMailbox.deliver")((input) =>
          Schema.decodeUnknownEffect(Schema.toType(Deliver.Input))({
            ...input,
            recipientDid: identity.did,
          }).pipe(Effect.flatMap(client.deliver), Effect.mapError(clientError))
        ),
        lease: {
          acquire: Effect.fn("RatKingMailbox.lease.acquire")((input) =>
            Schema.decodeUnknownEffect(Schema.toType(Acquire.Input))(
              input
            ).pipe(
              Effect.flatMap(client.acquireLease),
              Effect.map((output) => output.lease),
              Effect.mapError(clientError)
            )
          ),
          release: Effect.fn("RatKingMailbox.lease.release")((input) =>
            Schema.decodeUnknownEffect(Schema.toType(Release.Input))(
              input
            ).pipe(
              Effect.flatMap(client.releaseLease),
              Effect.mapError(clientError)
            )
          ),
          renew: Effect.fn("RatKingMailbox.lease.renew")((input) =>
            Schema.decodeUnknownEffect(Schema.toType(Renew.Input))(input).pipe(
              Effect.flatMap(client.renewLease),
              Effect.map((output) => output.lease),
              Effect.mapError(clientError)
            )
          ),
          resolve: Effect.fn("RatKingMailbox.lease.resolve")((did) =>
            Schema.decodeUnknownEffect(Schema.toType(Resolve.Params))({
              did,
            }).pipe(
              Effect.flatMap(client.resolveLease),
              Effect.map((output) => output.lease),
              Effect.mapError(clientError)
            )
          ),
        },
        list,
        open: Effect.fn("RatKingMailbox.open")(function* open(input, receipt) {
          const envelope = yield* Schema.decodeUnknownEffect(
            Schema.toType(Defs.EncryptedEnvelope)
          )(input);

          const payload = yield* openReceived(
            envelope,
            receipt,
            identity,
            resolver
          );

          const body = yield* decodeBody(payload.body);
          const via = receipt?.via;

          const carbonCopy = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                $type: Schema.Literal("sh.mschf.ratking.mailbox.cc"),
                body: Schema.String,
                primary: Schema.Struct({
                  messageId: Schema.String,
                  recipientDid: Schema.String,
                  senderDid: Schema.String,
                }),
              })
            )
          )(body).pipe(Effect.option);

          const result: MutableOpenedMessage = {
            body,
            encrypted: !plaintext(envelope),
            senderDid: payload.aad.senderDid,
            tid: payload.aad.messageId,
            verified: true,
          };

          if (via !== undefined) {
            result.via = { desk: via.desk, deskDid: via.deskDid, run: via.run };
          }

          if (receipt?.delegatedTo !== undefined) {
            result.delegatedTo = receipt.delegatedTo;
          }

          if (
            receipt?.delegatedFor !== undefined &&
            receipt.originalId !== undefined
          ) {
            result.delegatedFor = receipt.delegatedFor;
            result.originalId = receipt.originalId;
            result.tid = receipt.message.messageId;
          }

          if (Option.isSome(carbonCopy)) {
            if (
              carbonCopy.value.primary.senderDid !== payload.aad.senderDid ||
              carbonCopy.value.primary.messageId !==
                payload.replyTo?.messageId ||
              payload.replyTo.senderDid !== payload.aad.senderDid
            ) {
              return yield* new MailboxClientError({
                reason: "Invalid CC primary link",
              });
            }

            result.cc = carbonCopy.value.primary;
            result.body = carbonCopy.value.body;
          }

          if (payload.replyTo !== undefined) {
            result.replyTo = payload.replyTo;
          }

          if (payload.urgent !== undefined) {
            result.urgent = payload.urgent;
          }

          return result;
        }, Effect.mapError(clientError)),
        poll,
        putDidDocument: Effect.fn("RatKingMailbox.putDidDocument")((document) =>
          Schema.decodeUnknownEffect(Schema.toType(Put.Input))({
            document,
          }).pipe(
            Effect.flatMap(client.putDidDocument),
            Effect.mapError(clientError)
          )
        ),
        send: Effect.fn("RatKingMailbox.send")(
          function* send(to, body, opts) {
            if (opts?.recordType !== undefined) {
              const presence = yield* lookupPresence(to).pipe(
                Effect.provideService(Transport, transport),
                Deadline.timeoutOption("2 seconds"),
                Effect.orElseSucceed(() => Option.none())
              );

              const reason = readerCannotRender(
                to,
                opts.recordType,
                Option.getOrUndefined(presence)
              );

              if (reason !== undefined) {
                return yield* new MailboxClientError({ reason });
              }
            }

            if (opts?.fence !== undefined && opts.fence.did !== identity.did) {
              return yield* new MailboxClientError({
                reason: "Send fence DID differs from sender",
              });
            }

            const now = yield* Clock.currentTimeMillis;

            const messageId = yield* Effect.sync(() => randomTid(now));

            const aad: RawAad = {
              messageId,
              recipientDid: to,
              recipientKeyId: `${to}#encryption`,
              senderDid: identity.did,
            };

            if (opts?.expiresAt !== undefined) {
              aad.expiresAt = opts.expiresAt;
            }

            const raw: RawSigningPayload = {
              aad,
              body: new TextEncoder().encode(body),
              suite: opts?.encrypt === false ? plaintextSuite : suite,
              version: 1,
            };

            if (opts?.replyTo !== undefined) {
              raw.replyTo = opts.replyTo;
            }

            if (opts?.urgent !== undefined) {
              raw.urgent = opts.urgent;
            }

            const payload = yield* Schema.decodeUnknownEffect(
              Schema.toType(Defs.SigningPayload)
            )(raw);

            const envelope = yield* seal({
              payload,
              recipientKey: yield* resolver.resolve(
                to,
                payload.aad.recipientKeyId,
                "keyAgreement"
              ),
              recipientKeyId: payload.aad.recipientKeyId,
              signingKey: yield* importSigning(identity),
              signingKeyId: `${identity.did}#atproto`,
            });

            const input: SealedSendInput = {
              envelope,
              ...sendIntent(opts),
            };

            if (opts?.fence !== undefined) {
              input.generation = opts.fence.generation;
              input.leaseId = opts.fence.leaseId;
            }

            return yield* client.send(
              yield* Schema.decodeUnknownEffect(Schema.toType(Send.Input))(
                input
              )
            );
          },
          (effect) =>
            effect.pipe(
              Deadline.timeout(Deadline.OPERATION_MS),
              Effect.mapError(clientError)
            )
        ),
        watch: (afterSeq, fence, onRetry) =>
          watch(config, poll, afterSeq, fence, onRetry),
      });
    })
  ).pipe(
    Layer.provide([
      resolverLayer,
      clientLayer.pipe(
        Layer.provideMerge(
          transportLayer(
            config.endpoint,
            config.serviceDid.replace(/(?:#mailbox)?$/u, "#mailbox"),
            config.identity
          )
        )
      ),
    ])
  );
