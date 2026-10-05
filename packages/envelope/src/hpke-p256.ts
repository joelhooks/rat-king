// @effect-diagnostics asyncFunction:off -- Unreviewed P-256 compatibility code: HPKE's primitive extension point requires Promise-returning WebCrypto adapters.
import { DhkemP256HkdfSha256 } from "@hpke/core";

import { EnvelopeFailure } from "./failure.ts";

const spkiPrefix = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

export const p256PublicPoint = (raw: ArrayBuffer): ArrayBuffer => {
  const bytes = new Uint8Array(raw);

  if (bytes.length === 65 && bytes[0] === 0x04) {
    return raw;
  }

  if (
    bytes.length === 91 &&
    spkiPrefix.every((byte, index) => bytes[index] === byte) &&
    bytes[26] === 0x04
  ) {
    return raw.slice(26);
  }

  throw new EnvelopeFailure({ reason: "Invalid raw P-256 public key export" });
};

const p256Prime =
  0xff_ff_ff_ff_00_00_00_01_00_00_00_00_00_00_00_00_00_00_00_00_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ffn;

const p256B =
  0x5a_c6_35_d8_aa_3a_93_e7_b3_eb_bd_55_76_98_86_bc_65_1d_06_b0_cc_53_b0_f6_3b_ce_3c_3e_27_d2_60_4bn;

const coordinate = (bytes: Uint8Array) =>
  bytes.reduce((value, byte) => value * 256n + BigInt(byte), 0n);

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const p256PublicJwk = (
  raw: ArrayBufferLike | ArrayBufferView
): JsonWebKey => {
  const bytes = ArrayBuffer.isView(raw)
    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    : new Uint8Array(raw);

  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new EnvelopeFailure({ reason: "Invalid SEC1 P-256 public key" });
  }

  const xBytes = bytes.subarray(1, 33);
  const yBytes = bytes.subarray(33);
  const x = coordinate(xBytes);
  const y = coordinate(yBytes);

  const rhs =
    (((x * x * x - 3n * x + p256B) % p256Prime) + p256Prime) % p256Prime;

  if (
    x <= 0n ||
    x >= p256Prime ||
    y <= 0n ||
    y >= p256Prime ||
    (y * y) % p256Prime !== rhs
  ) {
    throw new EnvelopeFailure({ reason: "Off-curve P-256 public key" });
  }

  return {
    crv: "P-256",
    kty: "EC",
    x: base64url(xBytes),
    y: base64url(yBytes),
  };
};

export class CompatibleP256Kem extends DhkemP256HkdfSha256 {
  constructor() {
    super();
    const serialize = this._prim.serializePublicKey.bind(this._prim);
    this._prim.deserializePublicKey = async (raw) =>
      await this._prim.importKey("jwk", p256PublicJwk(raw), true);
    this._prim.serializePublicKey = async (key) => {
      const raw = await serialize(key);

      if (
        key.type === "public" &&
        "namedCurve" in key.algorithm &&
        key.algorithm.namedCurve === "P-256"
      ) {
        return p256PublicPoint(raw);
      }

      return raw;
    };
  }
}
