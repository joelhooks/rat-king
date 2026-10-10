import {
  plaintext,
  plaintextSuite,
  seal as sealEnvelope,
  suite,
} from "@rat-king/envelope";
import { canonical } from "@rat-king/envelope/canonical";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxClient, clientLayer } from "@rat-king/lexicon/mailbox-client";
import * as Peer from "@rat-king/lexicon/mailbox.getPeerDocument";
import * as Send from "@rat-king/lexicon/mailbox.send";
import { Transport } from "@rat-king/lexicon/transport";
import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Predicate,
  Result,
  Schema,
} from "effect";

import { base64url, Document, DidResolver, documentResolver } from "./auth.ts";
import { consume } from "./consume.ts";
import type { ConsumeOptions, MessageMeta } from "./consume.ts";
import { clientError, MailboxClientError } from "./error.ts";
import { importSigning, Identity } from "./identity.ts";
import type { IdentityValue } from "./identity.ts";
import { layer, RatKingMailbox } from "./mailbox.ts";
import type { LeaseFence, OpenedMessage, SendOptions } from "./mailbox.ts";
import { randomTid } from "./tid.ts";
import { transportLayer } from "./transport.ts";

const ownBrand: unique symbol = Symbol("OwnIdentity");

export interface OwnIdentity {
  readonly [ownBrand]: true;
}

const identities = new WeakMap<OwnIdentity, IdentityValue>();

export const ownIdentity = Effect.fn("Mailbox.ownIdentity")(
  function* ownIdentity(value: IdentityValue) {
    const identity = yield* Schema.decodeUnknownEffect(Identity)(value).pipe(
      Effect.mapError(clientError)
    );

    yield* importSigning(identity).pipe(Effect.mapError(clientError));

    const handle: OwnIdentity = Object.freeze<OwnIdentity>({
      [ownBrand]: true,
    });

    identities.set(handle, identity);

    return handle;
  }
);

export type PeerDocument = typeof Document.Type;

export type SendOutcome =
  | { readonly _tag: "NotAttempted"; readonly reason: string }
  | { readonly _tag: "Rejected"; readonly error: MailboxClientError }
  | { readonly _tag: "Accepted"; readonly receipt: Send.OutputValue["receipt"] }
  | { readonly _tag: "Uncertain"; readonly error: MailboxClientError };

export const SendOutcomes = Data.taggedEnum<SendOutcome>();

export type SendResult = SendOutcome & { readonly cc?: SendOutcome };

export interface PrepareOptions {
  readonly own: OwnIdentity;
  readonly peers: readonly PeerDocument[];
  readonly endpoint: string;
  readonly serviceDid: string;
}

const failure = (reason: string) => new MailboxClientError({ reason });

const sameDocument = (a: PeerDocument, b: PeerDocument) =>
  base64url(canonical(a)) === base64url(canonical(b));

export const prepare = Effect.fn("Mailbox.prepare")(function* prepare(
  options: PrepareOptions
) {
  const identity = identities.get(options.own);

  if (identity === undefined) {
    return yield* failure("Unknown own identity handle");
  }

  const peers = new Map<string, PeerDocument>();

  for (const value of options.peers) {
    const peer = yield* Schema.decodeUnknownEffect(Document)(value).pipe(
      Effect.mapError(clientError)
    );

    const existing = peers.get(peer.id);

    if (existing !== undefined && !sameDocument(existing, peer)) {
      return yield* failure("Conflicting peer documents");
    }

    peers.set(peer.id, peer);
  }

  const resolverLayer = documentResolver((did) =>
    Effect.sync(() => peers.get(did))
  );

  const config = {
    documents: yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.toType(Defs.DidDocument))
    )(options.peers).pipe(Effect.mapError(clientError)),
    endpoint: options.endpoint,
    identity,
    serviceDid: options.serviceDid,
  };

  const authLayer = transportLayer(
    options.endpoint,
    `${options.serviceDid.replace(/#mailbox$/u, "")}#mailbox`,
    identity
  );

  const context = yield* Layer.build(
    clientLayer.pipe(Layer.provide(authLayer))
  );

  const client = Context.get(context, MailboxClient);
  const transportContext = yield* Layer.build(authLayer);
  const transport = Context.get(transportContext, Transport);
  const resolverContext = yield* Layer.build(resolverLayer);
  const resolver = Context.get(resolverContext, DidResolver);
  const mailboxContext = yield* Layer.build(layer(config, resolverLayer));
  const mailbox = Context.get(mailboxContext, RatKingMailbox);

  const signingKey = yield* importSigning(identity).pipe(
    Effect.mapError(clientError)
  );

  const payloads = new WeakMap<
    Defs.EncryptedEnvelopeValue,
    Defs.SigningPayloadValue
  >();

  const copies = new WeakMap<
    Defs.EncryptedEnvelopeValue,
    Map<string, Defs.EncryptedEnvelopeValue>
  >();

  let consuming = false;

  const seal = Effect.fn("Mailbox.seal")(function* seal(
    to: string,
    body: string,
    opts?: SendOptions
  ) {
    const now = yield* Clock.currentTimeMillis;

    const messageId = randomTid(now);

    const raw = {
      aad: {
        messageId,
        recipientDid: to,
        recipientKeyId: `${to}#encryption`,
        senderDid: identity.did,
      },
      body: new TextEncoder().encode(body),
      suite: opts?.encrypt === false ? plaintextSuite : suite,
      version: 1,
    };

    if (opts?.expiresAt !== undefined) {
      Object.assign(raw.aad, { expiresAt: opts.expiresAt });
    }

    if (opts?.replyTo !== undefined) {
      Object.assign(raw, { replyTo: opts.replyTo });
    }

    if (opts?.urgent !== undefined) {
      Object.assign(raw, { urgent: opts.urgent });
    }

    const payload = yield* Schema.decodeUnknownEffect(
      Schema.toType(Defs.SigningPayload)
    )(raw).pipe(Effect.mapError(clientError));

    const envelope = yield* sealEnvelope({
      payload,
      recipientKey: yield* resolver.resolve(
        to,
        `${to}#encryption`,
        "keyAgreement"
      ),
      recipientKeyId: `${to}#encryption`,
      signingKey,
      signingKeyId: `${identity.did}#atproto`,
    }).pipe(Effect.mapError(clientError));

    payloads.set(envelope, payload);

    return envelope;
  });

  const submit = Effect.fn("Mailbox.submit")(function* submit(
    envelope: Defs.EncryptedEnvelopeValue,
    fence?: LeaseFence
  ) {
    if (
      envelope.aad.senderDid !== identity.did ||
      (fence !== undefined && fence.did !== identity.did)
    ) {
      return SendOutcomes.NotAttempted({
        reason: "Sender identity or fence mismatch",
      });
    }

    const raw = { envelope };

    if (fence !== undefined) {
      Object.assign(raw, {
        generation: fence.generation,
        leaseId: fence.leaseId,
      });
    }

    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.toType(Send.Input)
    )(raw).pipe(Effect.mapError(clientError), Effect.result);

    if (Result.isFailure(decoded)) {
      return SendOutcomes.NotAttempted({ reason: decoded.failure.reason });
    }

    const result = yield* client
      .send(decoded.success)
      .pipe(Effect.mapError(clientError), Effect.result);

    if (Result.isSuccess(result)) {
      return SendOutcomes.Accepted({ receipt: result.success.receipt });
    }

    const error = result.failure;

    return error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500
      ? SendOutcomes.Rejected({ error })
      : SendOutcomes.Uncertain({ error });
  });

  const send = Effect.fn("Mailbox.send")(function* send(
    envelope: Defs.EncryptedEnvelopeValue,
    opts?: { readonly cc?: string; readonly fence?: LeaseFence }
  ): Effect.fn.Return<SendResult> {
    if (!peers.has(envelope.aad.recipientDid)) {
      return SendOutcomes.NotAttempted({ reason: "Unknown primary peer" });
    }

    const primary = yield* submit(envelope, opts?.fence);

    if (opts?.cc === undefined) {
      return primary;
    }

    if (plaintext(envelope)) {
      return {
        ...primary,
        cc: SendOutcomes.NotAttempted({
          reason: "Plaintext primary is readable by observers without a CC",
        }),
      };
    }

    const payload = payloads.get(envelope);
    const did = opts.cc;

    if (
      payload === undefined ||
      !peers.has(did) ||
      did === envelope.aad.recipientDid ||
      !Predicate.isTagged(primary, "Accepted")
    ) {
      return {
        ...primary,
        cc: SendOutcomes.NotAttempted({
          reason:
            "CC requires an accepted locally sealed primary and a distinct known peer",
        }),
      };
    }

    const ccResult = yield* Effect.gen(function* carbonCopy() {
      const cached =
        copies.get(envelope) ?? new Map<string, Defs.EncryptedEnvelopeValue>();

      let copy = cached.get(did);

      if (copy === undefined) {
        const body = JSON.stringify({
          $type: "sh.mschf.ratking.mailbox.cc",
          body: new TextDecoder().decode(payload.body),
          primary: {
            messageId: envelope.aad.messageId,
            recipientDid: envelope.aad.recipientDid,
            senderDid: identity.did,
          },
        });

        const replyTo = yield* Schema.decodeUnknownEffect(
          Schema.toType(Defs.MessageRef)
        )({ messageId: envelope.aad.messageId, senderDid: identity.did }).pipe(
          Effect.mapError(clientError)
        );

        copy = yield* seal(did, body, { replyTo });
        cached.set(did, copy);
        copies.set(envelope, cached);
      }

      return yield* submit(copy, opts?.fence);
    }).pipe(
      Effect.mapError(clientError),
      Effect.catch((error) =>
        Effect.succeed(SendOutcomes.NotAttempted({ reason: error.reason }))
      )
    );

    return { ...primary, cc: ccResult };
  });

  const refresh = Effect.fn("Mailbox.refresh")(function* refresh(did: string) {
    const params = yield* Schema.decodeUnknownEffect(Peer.Params)({ did }).pipe(
      Effect.mapError(clientError)
    );

    const response = yield* transport
      .request({
        input: undefined,
        method: "GET",
        nsid: Peer.Method.nsid,
        params: yield* Schema.encodeEffect(Peer.Params)(params).pipe(
          Effect.mapError(clientError)
        ),
      })
      .pipe(Effect.mapError(clientError));

    if (response.kind !== "json" || response.status !== 200) {
      return yield* failure("Peer directory request refused");
    }

    const output = yield* Schema.decodeUnknownEffect(Peer.Output)(
      response.body
    ).pipe(Effect.mapError(clientError));

    const peer = yield* Schema.decodeUnknownEffect(Document)(
      output.document
    ).pipe(Effect.mapError(clientError));

    const existing = peers.get(did);

    if (
      peer.id !== did ||
      (existing !== undefined && !sameDocument(existing, peer))
    ) {
      return yield* failure(
        "Peer directory conflict; retained trusted document"
      );
    }

    peers.set(did, peer);

    return peer;
  });

  return {
    consume: <E, R>(
      handler: (
        message: OpenedMessage,
        meta: MessageMeta
      ) => Effect.Effect<void, E, R>,
      opts: ConsumeOptions
    ) =>
      Effect.suspend(() => {
        if (consuming) {
          return Effect.fail(failure("Consumer already active"));
        }

        consuming = true;

        return consume(mailbox, identity.did, handler, opts).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              consuming = false;
            })
          )
        );
      }),
    head: mailbox
      .list({ afterSeq: 0, limit: 1 })
      .pipe(Effect.map(({ throughSeq }) => throughSeq)),
    open: mailbox.open,
    refresh,
    resolveLease: mailbox.lease.resolve,
    seal,
    send,
  };
});
