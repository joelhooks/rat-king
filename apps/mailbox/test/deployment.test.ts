import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { expect } from "vitest";

import { prepareDeployment } from "../../../packages/alchemy-nest/src/deployment-build.ts";
import { wranglerConfiguration } from "../../../packages/alchemy-nest/src/deployment-config.ts";
import { bindings, hostedBindings, hostedVars } from "../src/bindings.ts";

it.effect(
  "generates configuration from the actual mailbox declaration and bundles ES2022 locally",
  () =>
    Effect.gen(function* deploymentBuild() {
      const input = {
        commit: "1234567",
        vars: { DID_DOCUMENTS: "[]", SERVICE_DID: "did:web:service.example" },
        version: "0.1.0-proof",
      };

      const configuration = yield* wranglerConfiguration(bindings, {
        ...input,
        main: "worker.mjs",
      });

      expect(configuration.durable_objects.bindings).toEqual(
        bindings.durable_objects.bindings
      );

      const prepared = yield* prepareDeployment(
        "apps/mailbox/src/worker.ts",
        bindings,
        input
      );

      expect(JSON.parse(prepared.configuration)).toEqual(configuration);
      expect(prepared.bundle).not.toContain("toSorted(");
      expect(prepared.bundle).not.toContain("__BUNDLE_VERSION__");
      expect(prepared.bundle).toContain("0.1.0-proof");
      expect(prepared.bundle).toContain("1234567");
      expect(prepared.bundle).toContain('from "cloudflare:workers"');
    })
);

const textBindingLimit = 5100;

const publicDocuments = (count: number) =>
  JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      authentication: [`did:web:n${index}.invalid#atproto`],
      id: `did:web:n${index}.invalid`,
      keyAgreement: [`did:web:n${index}.invalid#encryption`],
      verificationMethod: [
        {
          controller: `did:web:n${index}.invalid`,
          id: `did:web:n${index}.invalid#atproto`,
          publicKeyJwk: { crv: "P-256", kty: "EC", x: "x".repeat(43), y: "y" },
        },
      ],
    }))
  );

const hostedInput = (documents: string, bundleDocuments: boolean) => ({
  bundleDocuments,
  documents,
  gatewayModel: "",
  gatewayUrl: "",
  hostedDid: "did:web:hosted.invalid",
  model: "faux" as const,
  serviceDid: "did:web:service.invalid",
  sidecar: false,
});

it.effect(
  "hosted documents beyond the text binding cap travel in the bundle and stay out of every variable",
  () =>
    Effect.gen(function* bundledDocuments() {
      const documents = publicDocuments(40);

      expect(documents.length).toBeGreaterThan(textBindingLimit * 2);

      const vars = hostedVars(hostedInput(documents, true));

      const prepared = yield* prepareDeployment(
        "apps/mailbox/src/hosted-worker.ts",
        hostedBindings,
        { commit: "1234567", documents, vars, version: "0.1.0-proof" }
      );

      const { vars: configured } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ vars: Schema.Record(Schema.String, Schema.String) })
        )
      )(prepared.configuration);

      expect(Object.keys(configured)).not.toContain("DID_DOCUMENTS");
      expect(
        Math.max(...Object.values(configured).map((value) => value.length))
      ).toBeLessThan(textBindingLimit);
      expect(prepared.bundle).toContain("did:web:n39.invalid#encryption");
      expect(hostedVars(hostedInput(documents, false)).DID_DOCUMENTS).toBe(
        documents
      );
    })
);

it.effect("refuses to bundle documents carrying private key material", () =>
  Effect.gen(function* privateDocuments() {
    const documents = JSON.stringify([
      { verificationMethod: [{ publicKeyJwk: { d: "secret", kty: "EC" } }] },
    ]);

    const result = yield* prepareDeployment(
      "apps/mailbox/src/hosted-worker.ts",
      hostedBindings,
      {
        commit: "1234567",
        documents,
        vars: hostedVars(hostedInput(documents, true)),
        version: "0.1.0-proof",
      }
    ).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
  })
);
