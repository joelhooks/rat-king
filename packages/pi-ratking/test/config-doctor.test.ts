import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { inspectConfig } from "../src/config-doctor.ts";
import type { PiConfigValue } from "../src/config.ts";

it.effect.prop(
  "every missing document, script or service identity makes the doctor fail without revealing references",
  [
    Schema.Struct({
      document: Schema.Boolean,
      executable: Schema.Boolean,
      identity: Schema.Boolean,
      script: Schema.Boolean,
      service: Schema.Boolean,
    }),
  ],
  ([input]) =>
    Effect.gen(function* doctor() {
      const config: PiConfigValue = {
        didTemplate: "did:web:example.invalid:{agent}",
        documents: ["/private/document.invalid"],
        endpoint: "https://mailbox.invalid",
        issuer: input.service
          ? {
              endpoint: "https://issuer.invalid",
              host: "host_identity_invalid",
            }
          : { command: ["bash", "/private/issuer.invalid.sh"] },
        secretsCommand: "secret-store.invalid",
        serviceDid: "did:web:example.invalid",
      };

      const result = yield* inspectConfig(config, {
        executable: () => Effect.succeed(input.executable),
        hostIdentity: () => Effect.succeed(input.identity),
        readable: (file) =>
          Effect.succeed(
            file.includes("document") ? input.document : input.script
          ),
      });

      const count =
        Number(!input.document) +
        Number(!input.executable) +
        (input.service
          ? Number(!input.identity)
          : Number(!input.script) + Number(!input.executable));

      expect(result.status).toBe(count === 0 ? "ok" : "fail");
      expect(result.reasons).toHaveLength(count);
      expect(JSON.stringify(result)).not.toContain("/private/");
      expect(JSON.stringify(result)).not.toContain("host_identity_invalid");
    })
);
