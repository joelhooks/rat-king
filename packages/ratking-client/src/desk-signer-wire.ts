import {
  EnvelopeFailure,
  openCiphertext,
  plaintext,
  sign,
  supported,
} from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import type { IdentityValue } from "@rat-king/mailbox-client";
import {
  importAgreement,
  importSigning,
  PublicJwk,
} from "@rat-king/mailbox-client/identity";
import { Effect, Schema } from "effect";

import { AgentName, Did } from "./name.ts";

export const frameLimit = 1024 * 1024;

export const Description = Schema.Struct({
  agreement: PublicJwk,
  did: Did,
  name: AgentName,
  signing: PublicJwk,
});

export const Request = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("describe") }),
    Schema.Struct({
      envelope: Defs.EncryptedEnvelope,
      kind: Schema.Literal("open"),
    }),
    Schema.Struct({
      bytes: Schema.Uint8ArrayFromBase64Url,
      kind: Schema.Literal("sign"),
    }),
  ])
);

export const Response = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      data: Schema.Uint8ArrayFromBase64Url,
      kind: Schema.Literal("bytes"),
    }),
    Schema.Struct({ identity: Description, kind: Schema.Literal("describe") }),
    Schema.Struct({ kind: Schema.Literal("refused") }),
  ])
);

const encode = Schema.encodeEffect(Response);

const describeKey = ({ crv, kty, x, y }: typeof PublicJwk.Type) => ({
  crv,
  kty,
  x,
  y,
});

export const grantFailure = () =>
  new EnvelopeFailure({
    reason: "Desk signer unavailable or refused the grant request",
  });

export const signerRequests = Effect.fn("DeskSigner.requests")(
  function* signerRequests(name: string, identity: IdentityValue) {
    const description = yield* Schema.decodeUnknownEffect(Description)({
      agreement: describeKey(identity.agreement),
      did: identity.did,
      name,
      signing: describeKey(identity.signing),
    });

    const signing = yield* importSigning(identity);
    const agreement = yield* importAgreement(identity);

    return Effect.fn("DeskSigner.request")(
      function* respond(line: string) {
        const input = yield* Schema.decodeEffect(Request)(line, {
          onExcessProperty: "error",
        });

        if (input.kind === "describe") {
          return yield* encode({ identity: description, kind: "describe" });
        }

        if (input.kind === "sign") {
          return yield* encode({
            data: yield* sign(signing, input.bytes),
            kind: "bytes",
          });
        }

        const { envelope } = input;

        if (
          !supported(envelope) ||
          plaintext(envelope) ||
          envelope.aad.recipientDid !== identity.did ||
          envelope.aad.recipientKeyId !== `${identity.did}#encryption`
        ) {
          return yield* grantFailure();
        }

        return yield* encode({
          data: yield* openCiphertext(agreement, envelope),
          kind: "bytes",
        });
      },
      Effect.orElseSucceed(() => '{"kind":"refused"}')
    );
  }
);
