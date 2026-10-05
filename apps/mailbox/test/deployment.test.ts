import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { prepareDeployment } from "../../../packages/alchemy-nest/src/deployment-build.ts";
import { wranglerConfiguration } from "../../../packages/alchemy-nest/src/deployment-config.ts";
import { bindings } from "../src/bindings.ts";

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
