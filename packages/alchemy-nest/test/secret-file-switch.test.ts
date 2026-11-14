import * as Test from "@alchemy.run/test/Vitest";
import * as Output from "alchemy/Output";
import { State } from "alchemy/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { Context, Effect, Layer, Redacted } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { resolveFileContent } from "../src/file-content.ts";
import { HostShell } from "../src/host-shell.ts";
import {
  RemoteFile,
  RemoteFileProvider,
  SystemdUnit,
  SystemdUnitProvider,
} from "../src/providers.ts";
import { SecretSource } from "../src/secret-source.ts";
import {
  environmentContent,
  identityContent,
} from "../src/store-credentials.ts";
import { checkedStack } from "./checked-stack.ts";
import { service } from "./fixtures.ts";
import { credentialNames } from "./secret-fixtures.ts";

class Fake extends Context.Service<
  Fake,
  Effect.Success<ReturnType<typeof makeFakeShell>>
>()("Test/SecretSwitch") {}

const values = {
  [credentialNames.accessKey]: "a".repeat(32),
  [credentialNames.secretKey]: "b".repeat(64),
};

const fake = Layer.effectContext(
  Effect.gen(function* fixture() {
    const shell = yield* makeFakeShell();

    return Context.make(Fake, shell).pipe(Context.add(HostShell, shell.shell));
  })
);

const { test } = Test.make({
  providers: Layer.merge(RemoteFileProvider(), SystemdUnitProvider()).pipe(
    Layer.provideMerge(fake),
    Layer.provide(SecretSource.fromRecord(values))
  ),
  stage: "secret-switch",
});

const graph = (reference: boolean) =>
  Effect.gen(function* declareSwitch() {
    const credentials = {
      kind: "references",
      names: credentialNames,
    } as const;

    const identitySource = identityContent(credentials, "rat-king");

    if (identitySource.contentFrom === undefined) {
      return yield* Effect.die("Expected reference content.");
    }

    const identityText = yield* resolveFileContent({
      contentFrom: identitySource.contentFrom,
    }).pipe(Effect.provide(SecretSource.fromRecord(values)));

    const identity = yield* RemoteFile("identity", {
      ...(reference
        ? identitySource
        : { content: Redacted.make(identityText) }),
      mode: 0o600,
      path: "/home/example/.config/rat-king/s3.json",
    });

    const environment = yield* RemoteFile("environment", {
      ...(reference
        ? environmentContent(
            credentials,
            Output.literal("example-cells"),
            Output.literal("http://127.0.0.1:18333")
          )
        : {
            content: Redacted.make(
              `AWS_ACCESS_KEY_ID="${values[credentialNames.accessKey]}"\nAWS_SECRET_ACCESS_KEY="${values[credentialNames.secretKey]}"\nAWS_REGION=us-east-1\nS3_ENDPOINT="http://127.0.0.1:18333"\nCELLD_BUCKET="s3://example-cells"\nCELLD_OTEL=0\n`
            ),
          }),
      mode: 0o600,
      path: "/home/example/.config/rat-king/celld.env",
    });

    const weed = yield* SystemdUnit(
      "weed",
      identity.sha256.pipe(
        Output.map((sha256) => ({
          ...service("/home/example", "rat-king-seaweedfs.service"),
          restartOn: [sha256],
        }))
      )
    );

    const celld = yield* SystemdUnit(
      "celld",
      environment.sha256.pipe(
        Output.map((sha256) => ({
          ...service("/home/example", "rat-king-celld.service"),
          restartOn: [sha256],
        }))
      )
    );

    return {
      celld: celld.sha256,
      environment: environment.sha256,
      identity: identity.sha256,
      weed: weed.sha256,
    };
  });

test.provider(
  "same-value reference switch changes state metadata with zero file writes or unit restarts",
  (scratch) =>
    Effect.gen(function* switchMetadata() {
      const stack = checkedStack(scratch);
      const shell = yield* Fake;
      const before = yield* stack.deploy(graph(false));
      yield* shell.clear();
      const plan = yield* stack.plan(graph(true));
      expect(plan.resources.identity?.action).toBe("update");
      expect(plan.resources.environment?.action).toBe("update");
      expect(plan.resources.weed?.action).toBe("noop");
      expect(plan.resources.celld?.action).toBe("noop");
      const after = yield* stack.deploy(graph(true));
      expect(after).toEqual(before);
      const calls = yield* shell.calls();
      expect(calls.filter(({ operation }) => operation === "write")).toEqual(
        []
      );
      expect(
        calls.some(
          ({ argv }) => argv.includes("restart") || argv.includes("start")
        )
      ).toBe(false);
      const state = yield* yield* State;

      const rows = yield* Effect.forEach(["identity", "environment"], (fqn) =>
        state.get({ fqn, stack: scratch.name, stage: scratch.stage })
      );

      const encoded = JSON.stringify(encodeState(rows));
      expect(encoded).not.toContain("__redacted__");

      for (const value of Object.values(values)) {
        expect(encoded).not.toContain(value);
      }

      expect(encoded).toContain(credentialNames.accessKey);
    })
);
