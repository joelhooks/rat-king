import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { cryptoOperation, open, seal, suite, verify } from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import { Identity } from "@rat-king/mailbox-client";
import {
  Arbitrary,
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { expect } from "vitest";

import { Settings } from "../src/config.ts";
import { Request, Response, signerRequests } from "../src/desk-signer-wire.ts";
import { ensureIdentity } from "../src/identity.ts";
import { Issuer } from "../src/issuer.ts";
import { SecretStore } from "../src/secrets.ts";

const generateKey: (
  params: EcKeyGenParams,
  extractable: boolean,
  uses: KeyUsage[]
) => Promise<CryptoKeyPair> = crypto.subtle.generateKey.bind(crypto.subtle);

const makeKey = (name: "ECDSA" | "ECDH") =>
  cryptoOperation(
    generateKey.bind(
      crypto.subtle,
      { name, namedCurve: "P-256" },
      true,
      name === "ECDSA" ? ["sign", "verify"] : ["deriveBits"]
    )
  );

const fixture = Effect.gen(function* fixture() {
  const signing = yield* makeKey("ECDSA");
  const agreement = yield* makeKey("ECDH");

  const identity = yield* Schema.decodeUnknownEffect(Identity)({
    agreement: yield* cryptoOperation(
      crypto.subtle.exportKey.bind(crypto.subtle, "jwk", agreement.privateKey)
    ),
    did: "did:web:alpha.example.test",
    signing: yield* cryptoOperation(
      crypto.subtle.exportKey.bind(crypto.subtle, "jwk", signing.privateKey)
    ),
  });

  return { agreement, identity, signing };
});

it.effect.prop(
  "the grant signs bytes with exactly its own verification key",
  [Arbitrary.schema(Schema.String.check(Schema.isMaxLength(120)))],
  ([value]) =>
    Effect.gen(function* boundSignature() {
      const { identity, signing } = yield* fixture;
      const unrelated = yield* makeKey("ECDSA");
      const serve = yield* signerRequests("alpha", identity);
      const bytes = new TextEncoder().encode(value);

      const query = yield* Schema.encodeEffect(Request)({
        bytes,
        kind: "sign",
      });

      const response = yield* Schema.decodeEffect(Response)(
        yield* serve(query)
      );

      expect(response.kind).toBe("bytes");

      if (response.kind === "bytes") {
        expect(yield* verify(signing.publicKey, bytes, response.data)).toBe(
          true
        );
        expect(yield* verify(unrelated.publicKey, bytes, response.data)).toBe(
          false
        );
      }

      const named = JSON.stringify({
        bytes: Buffer.from(bytes).toString("base64url"),
        kind: "sign",
        name: "other",
      });

      expect(yield* Schema.decodeEffect(Response)(yield* serve(named))).toEqual(
        { kind: "refused" }
      );
    })
);

it.effect.prop(
  "the grant opens authenticated envelopes only for its recipient",
  [Arbitrary.schema(Schema.String.check(Schema.isMaxLength(120)))],
  ([value]) =>
    Effect.gen(function* roundtrip() {
      const { identity, agreement, signing } = yield* fixture;
      const serve = yield* signerRequests("alpha", identity);
      const recipientKeyId = `${identity.did}#encryption`;
      const senderDid = "did:web:sender.example.test";
      const message = new TextEncoder().encode(value);

      const sealFor = Effect.fn("Test.sealFor")(function* sealFor(
        recipientDid: string
      ) {
        const payload = yield* Schema.decodeUnknownEffect(
          Schema.toType(Defs.SigningPayload)
        )({
          aad: {
            messageId: "3kz5sxn2fga2a",
            recipientDid,
            recipientKeyId: `${recipientDid}#encryption`,
            senderDid,
          },
          body: message,
          suite,
          version: 1,
        });

        return yield* seal({
          payload,
          recipientKey: agreement.publicKey,
          recipientKeyId: `${recipientDid}#encryption`,
          signingKey: signing.privateKey,
          signingKeyId: `${senderDid}#atproto`,
        });
      });

      const envelope = yield* sealFor(identity.did);

      const ask = Effect.fn("Test.askSigner")(function* ask(
        candidate: typeof envelope
      ) {
        const line = yield* Schema.encodeEffect(Request)({
          envelope: candidate,
          kind: "open",
        });

        return yield* Schema.decodeEffect(Response)(yield* serve(line));
      });

      const response = yield* ask(envelope);
      expect(response.kind).toBe("bytes");

      if (response.kind === "bytes") {
        const payload = yield* open({
          envelope,
          recipientDid: identity.did,
          recipientKey: () => Effect.succeed(response.data),
          recipientKeyId,
          resolveSigningKey: () => Effect.succeed(signing.publicKey),
        });

        expect(payload.body).toEqual(message);
      }

      const otherRecipient = yield* sealFor("did:web:other.example.test");
      expect(yield* ask(otherRecipient)).toEqual({ kind: "refused" });
    })
);

const unset = () => Effect.die("protected name reached legacy custody");

it.effect(
  "a protected name with no fd fails before the legacy secret store or issuer",
  () =>
    Effect.gen(function* noGrant() {
      const result = yield* ensureIdentity("alpha").pipe(
        Effect.provideService(Settings, {
          askTimeoutMs: 1,
          didTemplate: "did:web:{agent}.example.test",
          directory: "unused",
          documents: [],
          encrypt: true,
          endpoint: "https://example.test",
          issuer: Option.none(),
          refuse: [],
          relays: [],
          reserved: {},
          secretsCommand: "unused",
          serviceDid: "did:web:mailbox.example.test",
          signerNames: ["alpha"],
          state: "unused",
        }),
        Effect.provideService(SecretStore, {
          add: unset,
          exists: unset,
          lease: unset,
        }),
        Effect.provideService(Issuer, {
          directory: unset,
          ensure: unset,
          names: unset(),
        }),
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            ConfigProvider.layer(ConfigProvider.fromUnknown({}))
          )
        ),
        Effect.flip
      );

      expect(result.reason).toBe(
        "Protected Rat King name requires an inherited desk signer grant"
      );
    })
);
