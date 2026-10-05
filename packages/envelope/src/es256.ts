/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Effect's lazy WebCrypto Promise adapters do not need redundant async wrappers. */
import { Effect } from "effect";

import { concatenate } from "./canonical.ts";
import { EnvelopeFailure } from "./failure.ts";
import { cryptoOperation } from "./webcrypto.ts";

export const p256Order =
  0xff_ff_ff_ff_00_00_00_00_ff_ff_ff_ff_ff_ff_ff_ff_bc_e6_fa_ad_a7_17_9e_84_f3_b9_ca_c2_fc_63_25_51n;

const scalar = (bytes: Uint8Array) =>
  BigInt(
    `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  );

const scalarBytes = (value: bigint) =>
  Uint8Array.from(
    value.toString(16).padStart(64, "0").match(/../gu) ?? [],
    (pair) => Number.parseInt(pair, 16)
  );

export const normalizeSignature = (signature: Uint8Array) => {
  if (signature.length !== 64) {
    throw new EnvelopeFailure({ reason: "ES256 requires 64 bytes" });
  }

  const s = scalar(signature.subarray(32));

  return concatenate(
    signature.subarray(0, 32),
    scalarBytes(s > p256Order / 2n ? p256Order - s : s)
  );
};

export const lowS = (signature: Uint8Array) =>
  signature.length === 64 &&
  scalar(signature.subarray(0, 32)) > 0n &&
  scalar(signature.subarray(0, 32)) < p256Order &&
  scalar(signature.subarray(32)) > 0n &&
  scalar(signature.subarray(32)) <= p256Order / 2n;

export const sign = Effect.fn("Envelope.sign")(function* sign(
  key: CryptoKey,
  bytes: Uint8Array
) {
  const signature = yield* cryptoOperation(() =>
    crypto.subtle.sign(
      { hash: "SHA-256", name: "ECDSA" },
      key,
      new Uint8Array(bytes)
    )
  );

  return normalizeSignature(new Uint8Array(signature));
});

export const verify = Effect.fn("Envelope.verify")(function* verify(
  key: CryptoKey,
  bytes: Uint8Array,
  signature: Uint8Array
) {
  if (!lowS(signature)) {
    return false;
  }

  return yield* cryptoOperation(() =>
    crypto.subtle.verify(
      { hash: "SHA-256", name: "ECDSA" },
      key,
      new Uint8Array(signature),
      new Uint8Array(bytes)
    )
  );
});
