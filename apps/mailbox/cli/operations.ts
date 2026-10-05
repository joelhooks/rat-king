// @effect-diagnostics nodeBuiltinImport:off -- CSPRNG supplies the TID clock identifier.
import { randomBytes } from "node:crypto";

import {
  open as openEnvelope,
  seal,
  suite,
  EnvelopeFailure,
} from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxClient } from "@rat-king/lexicon/mailbox-client";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as List from "@rat-king/lexicon/mailbox.list";
import { Transport } from "@rat-king/lexicon/transport";
import { Clock, Effect, Schema } from "effect";

import { DidResolver } from "../src/auth.ts";
import { proofLeasePath, ProofLease } from "../src/proof-lease.ts";
import { Lease } from "../src/store.ts";
import { tid } from "../src/tid.ts";
import { CliError, importSigning, importAgreement } from "./identity.ts";
import type { IdentityValue } from "./identity.ts";

export { tid } from "../src/tid.ts";

export const send = Effect.fn("MailboxCli.send")(function* send(
  identity: IdentityValue,
  recipientDid: string,
  body: string
) {
  const now = yield* Clock.currentTimeMillis;

  const clockId = yield* Effect.sync(() => {
    const bytes = randomBytes(2);

    return (bytes[0] ?? 0) * 256 + (bytes[1] ?? 0);
  });

  const payload = yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.SigningPayload)
  )({
    aad: {
      messageId: tid(now, clockId),
      recipientDid,
      recipientKeyId: `${recipientDid}#encryption`,
      senderDid: identity.did,
    },
    body: new TextEncoder().encode(body),
    suite,
    version: 1,
  });

  const resolver = yield* DidResolver;

  const envelope = yield* seal({
    payload,
    recipientKey: yield* resolver.resolve(
      recipientDid,
      payload.aad.recipientKeyId,
      "keyAgreement"
    ),
    recipientKeyId: payload.aad.recipientKeyId,
    signingKey: yield* importSigning(identity),
    signingKeyId: `${identity.did}#atproto`,
  });

  const client = yield* MailboxClient;

  return yield* client.send({ envelope });
});

interface ListInput {
  recipientDid: string;
  cursor?: string;
}

export const list = Effect.fn("MailboxCli.list")(function* list(
  identity: IdentityValue,
  cursor?: string
) {
  const client = yield* MailboxClient;

  const params: ListInput = {
    recipientDid: identity.did,
  };

  if (cursor !== undefined) {
    params.cursor = cursor;
  }

  return yield* client.list(
    yield* Schema.decodeUnknownEffect(Schema.toType(List.Params))(params)
  );
});

export interface ProofLeaseInput {
  leaseId: string;
  ttl: number;
  generation?: number;
  message?: { senderDid: string; messageId: string };
}

export const lease = Effect.fn("MailboxCli.lease")(function* lease(
  input: ProofLeaseInput
) {
  const transport = yield* Transport;

  const decoded = yield* Schema.decodeUnknownEffect(Schema.toType(ProofLease))(
    input
  );

  const response = yield* transport.request({
    input: yield* Schema.encodeEffect(ProofLease)(decoded),
    method: "POST",
    nsid: proofLeasePath,
    params: undefined,
  });

  if (response.kind !== "json" || response.status !== 200) {
    return yield* new CliError({ reason: "Proof lease request failed" });
  }

  return yield* Schema.decodeUnknownEffect(Lease)(response.body);
});

interface AckInput {
  leaseId: string;
  generation: number;
  sender: string;
  tid: string;
}

export const ack = Effect.fn("MailboxCli.ack")(function* ack(
  identity: IdentityValue,
  input: AckInput
) {
  const client = yield* MailboxClient;

  return yield* client.ack(
    yield* Schema.decodeUnknownEffect(Schema.toType(Ack.Input))({
      generation: input.generation,
      leaseId: input.leaseId,
      message: { messageId: input.tid, senderDid: input.sender },
      recipientDid: identity.did,
    })
  );
});

export interface OpenedMessage {
  body: string;
  replyTo?: Defs.MessageRefValue;
  senderDid: Defs.AadValue["senderDid"];
  tid: Defs.AadValue["messageId"];
  verified: true;
}

export const open = Effect.fn("MailboxCli.open")(function* open(
  identity: IdentityValue,
  input: typeof Defs.EncryptedEnvelope.Encoded
) {
  const envelope = yield* Schema.decodeUnknownEffect(Defs.EncryptedEnvelope)(
    input
  );

  const resolver = yield* DidResolver;

  const payload = yield* openEnvelope({
    envelope,
    recipientDid: identity.did,
    recipientKey: yield* importAgreement(identity),
    recipientKeyId: `${identity.did}#encryption`,
    resolveSigningKey: (did, keyId) =>
      resolver
        .resolve(did, keyId, "authentication")
        .pipe(
          Effect.mapError(
            () =>
              new EnvelopeFailure({ reason: "Unauthorized sender signing key" })
          )
        ),
  });

  const result: OpenedMessage = {
    body: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      payload.body
    ),
    senderDid: payload.aad.senderDid,
    tid: payload.aad.messageId,
    verified: true,
  };

  if (payload.replyTo !== undefined) {
    result.replyTo = payload.replyTo;
  }

  return result;
});
