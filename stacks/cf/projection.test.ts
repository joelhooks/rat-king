import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Redacted, Schema } from "effect";

import {
  bindings,
  hostedBindings,
  hostedVars,
} from "../../apps/mailbox/src/bindings.ts";
import {
  Declaration,
  wranglerConfiguration,
} from "../../packages/alchemy-nest/src/deployment-config.ts";
import { assertFaux } from "./inputs.ts";
import { projectWorker, workerName } from "./projection.ts";

const validDeclaration = Arbitrary.schema(Declaration).pipe(
  Arbitrary.map((declaration) => {
    const objects = [
      ...new Map(
        declaration.durable_objects.bindings.map((binding) => [
          binding.name,
          binding,
        ])
      ).values(),
    ].filter(
      (binding) =>
        binding.name !== "AGENT_IDENTITIES_CREDENTIAL" &&
        binding.name !== "AGENT_MODEL" &&
        binding.name.length > 0 &&
        binding.class_name.length > 0
    );

    return {
      ...declaration,
      durable_objects: { bindings: objects },
      migrations: [
        {
          new_sqlite_classes: objects.map((binding) => binding.class_name),
          tag: "v1",
        },
      ],
    };
  })
);

const Vars = Schema.Record(Schema.String, Schema.String);

it.effect.prop(
  "projects exactly the declaration and prepared bytes, without routes",
  {
    bundle: Schema.String,
    declaration: validDeclaration,
    secret: Schema.String,
    vars: Vars,
  },
  ({ declaration, vars, bundle, secret }) =>
    Effect.gen(function* projectionProperty() {
      const reserved = new Set([
        ...declaration.durable_objects.bindings.map((binding) => binding.name),
        "AGENT_IDENTITIES_CREDENTIAL",
      ]);

      const publicVars = Object.fromEntries(
        Object.entries(vars).filter(
          ([key]) =>
            !reserved.has(key) &&
            !key.startsWith("MODEL_GATEWAY_") &&
            !key.startsWith("CLAUDE_SIDECAR_")
        )
      );

      const configuration = yield* wranglerConfiguration(declaration, {
        commit: "property",
        main: "worker.mjs",
        vars: { ...publicVars, AGENT_MODEL: "faux" },
        version: "property",
      });

      const identity = Redacted.make(secret);

      const props = projectWorker(
        declaration,
        { bundle, configuration: JSON.stringify(configuration) },
        identity
      );

      expect(Object.keys(props).toSorted()).toEqual([
        "bundle",
        "compatibility",
        "env",
        "name",
        "script",
        "workersDev",
      ]);
      expect(props.name).toBe(workerName);
      expect(props.script).toBe(bundle);
      expect(props.bundle).toBe(false);
      expect(props.compatibility).toEqual({
        date: declaration.compatibility_date,
        flags: declaration.compatibility_flags,
      });
      expect(props.workersDev).toEqual({
        enabled: true,
        previewsEnabled: false,
      });
      expect(Object.keys(props.env).toSorted()).toEqual(
        [
          ...Object.keys(configuration.vars),
          ...declaration.durable_objects.bindings.map(
            (binding) => binding.name
          ),
          "AGENT_IDENTITIES_CREDENTIAL",
        ].toSorted()
      );

      for (const binding of declaration.durable_objects.bindings) {
        expect(props.env[binding.name]).toMatchObject({
          className: binding.class_name,
          kind: "Cloudflare.DurableObject",
          name: binding.name,
        });
      }

      for (const [key, value] of Object.entries(configuration.vars)) {
        expect(props.env[key]).toBe(value);
      }

      expect(props.env.AGENT_IDENTITIES_CREDENTIAL).toBe(identity);
      expect(Redacted.value(props.env.AGENT_IDENTITIES_CREDENTIAL)).toBe(
        secret
      );
    })
);

it.effect.prop(
  "nest configuration is byte-identical to the pre-refactor generator",
  {
    commit: Schema.NonEmptyString,
    documents: Schema.String,
    extraVars: Vars,
    gatewayModel: Schema.String,
    gatewayUrl: Schema.String,
    hostedDid: Schema.String,
    model: Schema.Literals(["faux", "gateway"]),
    serviceDid: Schema.String,
    sidecar: Schema.Boolean,
    version: Schema.NonEmptyString,
  },
  (input) =>
    Effect.gen(function* nestProperty() {
      const oldVars = {
        AGENT_MODEL: input.model,
        DID_DOCUMENTS: input.documents,
        HOSTED_AGENTS: JSON.stringify([input.hostedDid]),
        SERVICE_DID: input.serviceDid,
      };

      if (input.model === "gateway") {
        Object.assign(oldVars, {
          MODEL_GATEWAY_BASE_URL: input.gatewayUrl,
          MODEL_GATEWAY_MODEL: input.gatewayModel,
        });
      }

      if (input.sidecar) {
        Object.assign(oldVars, {
          CLAUDE_SIDECAR_BASE_URL: "http://127.0.0.1:18789/v1",
        });
      }

      const oldDeclaration = {
        ...bindings,
        durable_objects: {
          bindings: [
            ...bindings.durable_objects.bindings,
            { class_name: "Agent", name: "AGENT" },
          ],
        },
        migrations: [
          { new_sqlite_classes: ["Mailbox", "AuthTokens", "Agent"], tag: "v1" },
          { new_sqlite_classes: ["Issuer"], tag: "v2" },
        ],
      };

      const extras = Object.fromEntries(
        Object.entries(input.extraVars).filter(
          ([key]) =>
            !["MAILBOX", "AUTH_TOKENS", "ISSUER", "AGENT"].includes(key)
        )
      );

      const build = {
        commit: input.commit,
        main: "worker.mjs",
        version: input.version,
      };

      const before = yield* wranglerConfiguration(oldDeclaration, {
        ...build,
        vars: { ...extras, ...oldVars },
      });

      const after = yield* wranglerConfiguration(hostedBindings, {
        ...build,
        vars: { ...extras, ...hostedVars(input) },
      });

      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    })
);

it.prop(
  "rejects every gateway environment input regardless of its value",
  {
    suffix: Schema.String,
    value: Schema.String,
  },
  ({ suffix, value }) => {
    expect(() => {
      assertFaux({ [`MODEL_GATEWAY_${suffix}`]: value });
    }).toThrow("Preview forbids");
    expect(() => {
      assertFaux({ RAT_KING_AGENT_MODEL: "gateway" });
    }).toThrow("Preview forbids");
  }
);
