// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Standalone HPKE bootstrap uses the WebCrypto Promise API and writes authenticated bytes only.
import {
  closeSync,
  fchmodSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { Schema } from "effect";

import { CompatibleP256Kem } from "../../packages/envelope/src/hpke-p256.ts";
import { Document } from "../../packages/mailbox-client/src/auth.ts";
import { Identity } from "../../packages/mailbox-client/src/identity.ts";
import { addSecret, leaseSecret, validName } from "./private-store.ts";

const info = new TextEncoder().encode("sh.mschf.ratking.grokbox.bootstrap.v1");

const suite = new CipherSuite({
  aead: new Aes128Gcm(),
  kdf: new HkdfSha256(),
  kem: new CompatibleP256Kem(),
});

const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

const Blob = Schema.Struct({
  ct: Schema.String,
  enc: Schema.String,
  kid: Schema.String,
  v: Schema.Literal(1),
});

const JsonKey = Schema.Struct({
  crv: Schema.String,
  d: Schema.String,
  kty: Schema.String,
  x: Schema.String,
  y: Schema.String,
});

const publicKey = (key: {
  readonly crv: string;
  readonly kty: string;
  readonly x: string;
  readonly y: string;
}) => ({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });

const generate = async (name: "ECDSA" | "ECDH", usages: KeyUsage[]) => {
  const pair = await crypto.subtle.generateKey(
    { name, namedCurve: "P-256" },
    true,
    usages
  );

  return Schema.decodeUnknownSync(JsonKey)(
    await crypto.subtle.exportKey("jwk", pair.privateKey)
  );
};

export const mintHost = async (argv: readonly string[]) => {
  const [did, secret, ...extra] = argv;

  if (
    did === undefined ||
    !/^did:web:[^\s#/?]+$/u.test(did) ||
    !validName(secret) ||
    extra.length !== 0
  ) {
    throw new Error("usage");
  }

  const signing = await generate("ECDSA", ["sign", "verify"]);
  const agreement = await generate("ECDH", ["deriveBits"]);
  addSecret(secret, JSON.stringify({ agreement, did, signing }));

  return {
    authentication: [`${did}#atproto`],
    id: did,
    keyAgreement: [`${did}#encryption`],
    verificationMethod: [
      {
        controller: did,
        id: `${did}#atproto`,
        publicKeyJwk: publicKey(signing),
      },
      {
        controller: did,
        id: `${did}#encryption`,
        publicKeyJwk: publicKey(agreement),
      },
    ],
  };
};

export const seal = async (argv: readonly string[]) => {
  const [file] = argv;

  if (argv.length !== 1 || file === undefined) {
    throw new Error("usage");
  }

  const document = Schema.decodeUnknownSync(Schema.fromJsonString(Document))(
    readFileSync(file, "utf-8")
  );

  const kid = `${document.id}#encryption`;
  const method = document.verificationMethod.find((entry) => entry.id === kid);

  if (method === undefined || "d" in method.publicKeyJwk) {
    throw new Error("need public key");
  }

  const recipientPublicKey = await crypto.subtle.importKey(
    "jwk",
    method.publicKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  const secret = readFileSync(0);

  if (secret.length === 0) {
    throw new Error("empty input");
  }

  const sender = await suite.createSenderContext({ info, recipientPublicKey });
  const ct = await sender.seal(secret, new TextEncoder().encode(kid));

  return { ct: b64(ct), enc: b64(sender.enc), kid, v: 1 };
};

export const openSealed = async (argv: readonly string[]) => {
  const [out, secret = process.env.RATKING_HOST_IDENTITY, ...extra] = argv;

  if (out === undefined || secret === undefined || extra.length !== 0) {
    throw new Error("usage");
  }

  const blob = Schema.decodeUnknownSync(Schema.fromJsonString(Blob))(
    readFileSync(0, "utf-8")
  );

  const identity = Schema.decodeUnknownSync(Schema.fromJsonString(Identity))(
    leaseSecret(secret)
  );

  if (blob.kid !== `${identity.did}#encryption`) {
    throw new Error("wrong host");
  }

  const recipientKey = await crypto.subtle.importKey(
    "jwk",
    identity.agreement,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const publicJwk = publicKey(identity.agreement);

  const publicCryptoKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  const recipient = await suite.createRecipientContext({
    enc: Buffer.from(blob.enc, "base64url"),
    info,
    recipientKey: { privateKey: recipientKey, publicKey: publicCryptoKey },
  });

  const plain = await recipient.open(
    Buffer.from(blob.ct, "base64url"),
    new TextEncoder().encode(blob.kid)
  );

  const fd = openSync(out, "wx", 0o600);

  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, Buffer.from(plain));
  } finally {
    closeSync(fd);
  }
};
