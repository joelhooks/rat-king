import { it } from "@effect/vitest";
import { Identity } from "@rat-king/mailbox-client/identity";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { expect } from "vitest";

import { Settings } from "../src/config.ts";
import { publicDocument, signerSelection } from "../src/identity.ts";
import { alpha, id, template } from "./client-rule-inputs.ts";

const signingPath = (
  name: string,
  signerNames: readonly string[],
  env: Readonly<Record<string, string>>
) =>
  signerSelection(name).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          Settings,
          Settings.of({
            askTimeoutMs: 600_000,
            didTemplate: template,
            directory: "/example/directory.json",
            documents: [],
            encrypt: false,
            endpoint: "https://example.invalid",
            issuer: Option.none(),
            refuse: [],
            relays: [],
            reserved: {
              "project/desk": {
                aliases: ["legacy"],
                did: "did:web:example.invalid:desk",
              },
            },
            secretsCommand: "example",
            serviceDid: "did:web:example.invalid",
            signerNames,
            state: "/example/state",
          })
        ),
        ConfigProvider.layer(ConfigProvider.fromUnknown(env))
      )
    )
  );

it.prop(
  "the public identity document never carries either private scalar",
  [Identity],
  ([identity]) => {
    const methods = publicDocument(identity).verificationMethod;
    expect(methods).toHaveLength(2);
    expect(
      methods.every((method) => !Object.hasOwn(method.publicKeyJwk, "d"))
    ).toBe(true);
  }
);

it.prop(
  "authentication and agreement point at distinct advertised methods on the same DID",
  [Identity, id],
  ([identity, n]) => {
    const did = `did:web:example.invalid:fixture:${n}`;
    const document = publicDocument({ ...identity, did });
    expect(document.id).toBe(did);
    expect(document.authentication).toEqual([`${did}#atproto`]);
    expect(document.keyAgreement).toEqual([`${did}#encryption`]);
    expect(
      document.verificationMethod.map(({ controller, id: ref }) => ({
        controller,
        ref,
      }))
    ).toEqual([
      { controller: did, ref: `${did}#atproto` },
      { controller: did, ref: `${did}#encryption` },
    ]);
  }
);

it.prop(
  "public signing and agreement coordinates are never swapped",
  [Identity, id],
  ([identity, n]) => {
    const signing = { ...identity.signing, x: `sign-${n}` };
    const agreement = { ...identity.agreement, x: `agree-${n}` };

    const [first, second] = publicDocument({
      ...identity,
      agreement,
      signing,
    }).verificationMethod;

    expect(first?.publicKeyJwk).toEqual({
      crv: signing.crv,
      kty: signing.kty,
      x: signing.x,
      y: signing.y,
    });
    expect(second?.publicKeyJwk).toEqual({
      crv: agreement.crv,
      kty: agreement.kty,
      x: agreement.x,
      y: agreement.y,
    });
  }
);

it.effect.prop(
  "any explicit integer signer descriptor selects the managed signing path",
  [alpha(12), id],
  ([name, fd]) =>
    Effect.gen(function* explicitSigner() {
      expect(
        yield* signingPath(name, [], { RATKING_SIGNER_FD: String(fd) })
      ).toEqual({ fd: Option.some(fd), required: true });
    })
);

it.effect.prop(
  "a reserved alias inherits its canonical managed signer policy",
  [alpha(12)],
  ([other]) =>
    Effect.gen(function* aliasSigner() {
      expect(
        yield* signingPath("legacy", [`other-${other}`, "project/desk"], {})
      ).toEqual({ fd: Option.none(), required: true });
      expect(yield* signingPath("legacy", [`other-${other}`], {})).toEqual({
        fd: Option.none(),
        required: false,
      });
    })
);

it.effect.prop(
  "a bad signer descriptor fails rather than silently choosing local keys",
  [alpha(12)],
  ([suffix]) =>
    Effect.gen(function* invalidSigner() {
      const result = yield* signingPath(`desk-${suffix}`, [], {
        RATKING_SIGNER_FD: `bad-${suffix}`,
      }).pipe(Effect.result);

      expect(result).toMatchObject({
        failure: {
          reason: "Invalid desk signer descriptor configuration",
        },
      });
    })
);
