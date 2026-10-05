import { expect, it } from "vitest";

import { EnvelopeFailure } from "../src/failure.ts";
import { p256PublicJwk, p256PublicPoint } from "../src/hpke-p256.ts";

it("passes SEC1 through, unwraps exact P-256 SPKI, refuses anything else", () => {
  const point = new Uint8Array(65);
  point[0] = 0x04;
  expect(p256PublicPoint(point.buffer)).toBe(point.buffer);

  const prefix = Uint8Array.from(
    Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex")
  );

  const spki = new Uint8Array(91);
  spki.set(prefix);
  spki.set(point, 26);
  expect(new Uint8Array(p256PublicPoint(spki.buffer))).toEqual(point);
  spki[0] = 0;
  expect(() => p256PublicPoint(spki.buffer)).toThrow(EnvelopeFailure);
  spki.set(prefix);
  spki[26] = 0;
  expect(() => p256PublicPoint(spki.buffer)).toThrow(EnvelopeFailure);
  expect(() => p256PublicPoint(new ArrayBuffer(65))).toThrow(EnvelopeFailure);
});

it("refuses an off-curve SEC1 point before JWK import", () => {
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point[32] = 1;
  point[64] = 1;
  expect(() => p256PublicJwk(point)).toThrow(EnvelopeFailure);
});
