/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { concatenate, cryptoOperation, hpke } from "../src/envelope.ts";
import vectors from "./vectors/rfc9180-p256-sha256-aes128gcm-base.json" with { type: "json" };

const hex = (text: string) =>
  Uint8Array.from(text.match(/../gu) ?? [], (pair) =>
    Number.parseInt(pair, 16)
  );

const compare = (bytes: ArrayBuffer | Uint8Array, expected: string) => {
  expect(new Uint8Array(bytes)).toEqual(hex(expected));
};

it.effect(
  "RFC 9180 suite (16,1,1) base: derivation, KEM, schedule, all seals/opens and exports",
  () =>
    Effect.gen(function* step1() {
      for (const vector of vectors) {
        const recipient = yield* cryptoOperation(() =>
          hpke.kem.deriveKeyPair(hex(vector.ikmR))
        );

        const ephemeral = yield* cryptoOperation(() =>
          hpke.kem.deriveKeyPair(hex(vector.ikmE))
        );

        compare(
          yield* cryptoOperation(() =>
            hpke.kem.serializePrivateKey(recipient.privateKey)
          ),
          vector.skRm
        );
        compare(
          yield* cryptoOperation(() =>
            hpke.kem.serializePublicKey(recipient.publicKey)
          ),
          vector.pkRm
        );
        compare(
          yield* cryptoOperation(() =>
            hpke.kem.serializePrivateKey(ephemeral.privateKey)
          ),
          vector.skEm
        );
        compare(
          yield* cryptoOperation(() =>
            hpke.kem.serializePublicKey(ephemeral.publicKey)
          ),
          vector.pkEm
        );

        const encapsulation = yield* cryptoOperation(() =>
          hpke.kem.encap({
            ekm: ephemeral,
            recipientPublicKey: recipient.publicKey,
          })
        );

        compare(encapsulation.enc, vector.enc);
        compare(encapsulation.sharedSecret, vector.shared_secret);
        compare(
          yield* cryptoOperation(() =>
            hpke.kem.decap({
              enc: encapsulation.enc,
              recipientKey: recipient.privateKey,
            })
          ),
          vector.shared_secret
        );
        const empty = new Uint8Array();

        const pskHash = yield* cryptoOperation(() =>
          hpke.kdf.labeledExtract(
            empty,
            new TextEncoder().encode("psk_id_hash"),
            empty
          )
        );

        const infoHash = yield* cryptoOperation(() =>
          hpke.kdf.labeledExtract(
            empty,
            new TextEncoder().encode("info_hash"),
            hex(vector.info)
          )
        );

        const schedule = concatenate(
          new Uint8Array([0]),
          new Uint8Array(pskHash),
          new Uint8Array(infoHash)
        );

        compare(schedule, vector.key_schedule_context);

        const secret = yield* cryptoOperation(() =>
          hpke.kdf.labeledExtract(
            encapsulation.sharedSecret,
            new TextEncoder().encode("secret"),
            empty
          )
        );

        compare(secret, vector.secret);

        for (const [label, length, expected] of [
          ["key", 16, vector.key],
          ["base_nonce", 12, vector.base_nonce],
          ["exp", 32, vector.exporter_secret],
        ] as const) {
          compare(
            yield* cryptoOperation(() =>
              hpke.kdf.labeledExpand(
                secret,
                new TextEncoder().encode(label),
                schedule,
                length
              )
            ),
            expected
          );
        }

        const sender = yield* cryptoOperation(() =>
          hpke.createSenderContext({
            ekm: ephemeral,
            info: hex(vector.info),
            recipientPublicKey: recipient.publicKey,
          })
        );

        const receiver = yield* cryptoOperation(() =>
          hpke.createRecipientContext({
            enc: sender.enc,
            info: hex(vector.info),
            recipientKey: recipient.privateKey,
          })
        );

        compare(sender.enc, vector.enc);

        for (const encryption of vector.encryptions) {
          compare(
            yield* cryptoOperation(() =>
              sender.seal(hex(encryption.pt), hex(encryption.aad))
            ),
            encryption.ct
          );
          compare(
            yield* cryptoOperation(() =>
              receiver.open(hex(encryption.ct), hex(encryption.aad))
            ),
            encryption.pt
          );
        }

        for (const exported of vector.exports) {
          compare(
            yield* cryptoOperation(() =>
              sender.export(hex(exported.exporter_context), exported.L)
            ),
            exported.exported_value
          );
          compare(
            yield* cryptoOperation(() =>
              receiver.export(hex(exported.exporter_context), exported.L)
            ),
            exported.exported_value
          );
        }
      }
    })
);
