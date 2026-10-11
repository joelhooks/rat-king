import {
  open as openEnvelope,
  plaintext,
  plaintextSuite,
  seal,
  suite,
  EnvelopeFailure,
} from "@rat-king/envelope";
import * as Put from "@rat-king/lexicon/admin.putDidDocument";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxClient, clientLayer } from "@rat-king/lexicon/mailbox-client";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as Deliver from "@rat-king/lexicon/mailbox.deliver";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Send from "@rat-king/lexicon/mailbox.send";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import type * as Lease from "@rat-king/lexicon/runtime.lease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import * as Resolve from "@rat-king/lexicon/runtime.resolveLease";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { Stream } from "effect";
import type { HttpClient } from "effect/http";

import { DidResolver, staticResolver } from "./auth.ts";
import { clientError, MailboxClientError } from "./error.ts";
import { importSigning, importAgreement } from "./identity.ts";
import type { IdentityValue } from "./identity.ts";
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
  envelope: Defs.EncryptedEnvelopeValue;
  generation?: number;
  leaseId?: string;
}

export interface ClientConfig {
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

export interface Batch {
  readonly events: List.OutputValue["events"];
  readonly throughSeq: number;
}

export interface OpenedMessage {
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
  readonly replyTo?: Defs.MessageRefValue;
  readonly expiresAt?: string;
  readonly fence?: LeaseFence;
  readonly urgent?: true;
  readonly encrypt?: boolean;
}

export interface FencedMessage {
  readonly message: Defs.MessageRefValue;
  readonly leaseId: string;
  readonly generation: number;
}

export interface AcquireRequest {
  readonly did: string;
  readonly harness: Lease.MainValue["harness"];
  readonly expiresAt: string;
  readonly leaseId?: string;
  readonly generation?: number;
}

export class RatKingMailbox extends Context.Service<
  RatKingMailbox,
  {
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
      fence: LeaseFence
    ) => Stream.Stream<Batch, MailboxClientError>;
    readonly open: (
      envelope: Defs.EncryptedEnvelopeValue
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
        input: LeaseFence & { readonly expiresAt: string }
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

      const poll = Effect.fn("RatKingMailbox.poll")(function* poll(
        afterSeq: number
      ) {
        const first = yield* list({ afterSeq });
        const events = [...first.events];
        let { cursor } = first;

        while (cursor !== undefined) {
          const page = yield* list({ afterSeq, cursor });

          if (page.throughSeq !== first.throughSeq) {
            return yield* new MailboxClientError({
              reason: "Snapshot watermark changed during pagination",
            });
          }

          events.push(...page.events);
          ({ cursor } = page);
        }

        return { events, throughSeq: first.throughSeq };
      });

      return RatKingMailbox.of({
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
        open: Effect.fn("RatKingMailbox.open")(function* open(input) {
          const envelope = yield* Schema.decodeUnknownEffect(
            Schema.toType(Defs.EncryptedEnvelope)
          )(input);

          const payload = yield* openEnvelope({
            envelope,
            recipientDid: identity.did,
            recipientKey: yield* importAgreement(identity),
            recipientKeyId: `${identity.did}#encryption`,
            resolveSigningKey: (did, keyId) =>
              resolver.resolve(did, keyId, "authentication").pipe(
                Effect.mapError(
                  () =>
                    new EnvelopeFailure({
                      reason: "Unauthorized sender signing key",
                    })
                )
              ),
          });

          const body = yield* Effect.try({
            catch: () =>
              new MailboxClientError({ reason: "Invalid UTF-8 body" }),
            try: () =>
              new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: false,
              }).decode(payload.body),
          });

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
        send: Effect.fn("RatKingMailbox.send")(function* send(to, body, opts) {
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

          const input: SealedSendInput = { envelope };

          if (opts?.fence !== undefined) {
            input.generation = opts.fence.generation;
            input.leaseId = opts.fence.leaseId;
          }

          return yield* client.send(
            yield* Schema.decodeUnknownEffect(Schema.toType(Send.Input))(input)
          );
        }, Effect.mapError(clientError)),
        watch: (afterSeq, fence) => watch(config, poll, afterSeq, fence),
      });
    })
  ).pipe(
    Layer.provide([
      resolverLayer,
      clientLayer.pipe(
        Layer.provide(
          transportLayer(
            config.endpoint,
            config.serviceDid.replace(/(?:#mailbox)?$/u, "#mailbox"),
            config.identity
          )
        )
      ),
    ])
  );
