/* oxlint-disable typescript/promise-function-async -- Lazy WebCrypto Promise thunks passed to the owning Effect adapter. */
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { EnvelopeFailure } from "../src/failure.ts";
import {
  CompatibleP256Kem,
  p256PublicJwk,
  p256PublicPoint,
} from "../src/hpke-p256.ts";
import { cryptoOperation } from "../src/webcrypto.ts";

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

const prime =
  0xff_ff_ff_ff_00_00_00_01_00_00_00_00_00_00_00_00_00_00_00_00_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ffn;

const witnessY =
  0x66_48_5c_78_0e_2f_83_d7_24_33_bd_5d_84_a0_6b_b6_54_1c_2a_f3_1d_ae_87_17_28_bf_85_6a_17_4f_93_f4n;

const coordinateBytes = (value: bigint) =>
  Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));

const pointAt = (x: bigint, y: bigint) => {
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(coordinateBytes(x), 1);
  point.set(coordinateBytes(y), 33);

  return point;
};

const Seed = Schema.Array(
  Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 }))
).check(Schema.isMinLength(32), Schema.isMaxLength(32));

it.live.prop(
  "imports finite P-256 points including zero x, rejects range, curve and encoding violations",
  [Arbitrary.schema(Seed)],
  ([seed]) =>
    Effect.gen(function* pointProperty() {
      const kem = new CompatibleP256Kem();

      const keys = yield* cryptoOperation(() =>
        kem.deriveKeyPair(Uint8Array.from(seed))
      );

      const generated = new Uint8Array(
        yield* cryptoOperation(() => kem.serializePublicKey(keys.publicKey))
      );

      for (const point of [
        generated,
        pointAt(0n, witnessY),
        pointAt(0n, prime - witnessY),
      ]) {
        const imported = yield* cryptoOperation(() =>
          kem.deserializePublicKey(point)
        );

        expect(
          new Uint8Array(
            yield* cryptoOperation(() => kem.serializePublicKey(imported))
          )
        ).toEqual(point);
      }

      const x = BigInt(
        `0x${Buffer.from(generated.subarray(1, 33)).toString("hex")}`
      );

      const y = BigInt(
        `0x${Buffer.from(generated.subarray(33)).toString("hex")}`
      );

      for (const invalid of [
        pointAt(prime, y),
        pointAt(prime + BigInt(seed[0] ?? 0), y),
        pointAt(x, prime),
        pointAt(x, prime + BigInt(seed[1] ?? 0)),
        pointAt(x, (y + 1n) % prime),
        pointAt(0n, 0n),
        new Uint8Array([0]),
        generated.subarray(0, 64),
        Uint8Array.from([4, ...generated]),
        Uint8Array.from([2, ...generated.subarray(1, 33)]),
      ]) {
        expect(() => p256PublicJwk(invalid)).toThrow(EnvelopeFailure);

        const result = yield* cryptoOperation(() =>
          kem.deserializePublicKey(invalid)
        ).pipe(Effect.result);

        expect(result._tag).toBe("Failure");
      }
    }),
  { arbitrary: { maxShrinks: 5 } }
);
