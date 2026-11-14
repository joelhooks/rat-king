import * as Test from "@alchemy.run/test/Vitest";
import { NodePath } from "@effect/platform-node";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { Context, Effect, Layer, Redacted } from "effect";
import { expect } from "vitest";

import { mailboxCliEnvironment } from "../../../stacks/nest/cli-environment.ts";
import { Celld } from "../src/celld.ts";
import { resolveFileContent } from "../src/file-content.ts";
import { textDigest } from "../src/files.ts";
import { ObjectStore } from "../src/object-store.ts";
import { RemoteFile } from "../src/providers.ts";
import { SecretSource } from "../src/secret-source.ts";
import { checkedStack } from "./checked-stack.ts";
import { renderProviders } from "./instance-render.ts";
import { credentialNames } from "./secret-fixtures.ts";

class SecretRendered extends Context.Service<
  SecretRendered,
  { readonly files: Map<string, string> }
>()("Test/SecretRendered") {}

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const values = {
  [credentialNames.accessKey]: 'fixture-access-"nested\\value',
  [credentialNames.secretKey]: "fixture-secret-$&\n{{ACCESS_KEY}}",
};

const fileProvider = Provider.effect(
  RemoteFile,
  Effect.gen(function* provider() {
    const rendered = yield* SecretRendered;
    const source = yield* SecretSource;

    return RemoteFile.Provider.of({
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
      read: ({ output }) => Effect.succeed(output),
      reconcile: Effect.fn("Test.secretFile.reconcile")(function* reconcile({
        news,
      }) {
        const text = yield* resolveFileContent(news).pipe(
          Effect.provideService(SecretSource, source)
        );

        rendered.files.set(news.path, text);

        const attr = {
          mode: news.mode ?? 0o644,
          path: news.path,
          sha256: textDigest(text),
        };

        return news.contentFrom === undefined
          ? attr
          : { ...attr, contentFrom: news.contentFrom };
      }),
    });
  })
);

const rendered = Layer.sync(SecretRendered, () => ({
  files: new Map<string, string>(),
}));

const { test } = Test.make({
  providers: Layer.merge(renderProviders, fileProvider).pipe(
    Layer.provideMerge(rendered),
    Layer.provide(SecretSource.fromRecord(values)),
    Layer.provide(NodePath.layer)
  ),
  stage: "secret-reference-state",
});

const graph = (legacy: boolean) =>
  Effect.gen(function* declareGraph() {
    const slice = yield* ObjectStore.Slice(host.home);

    const bucket = yield* ObjectStore.Bucket("store", {
      ...(legacy
        ? { legacyRandomCredentials: true }
        : { credentials: credentialNames }),
      host,
      name: "example-cells",
      slice: slice.sha256,
    });

    yield* Celld.Node("celld", { bucket, host });

    return yield* RemoteFile("mailbox-cli-environment", {
      content: mailboxCliEnvironment({
        home: host.home,
        serviceDid: "did:web:example.invalid",
        workerUrl: "https://mailbox.example.invalid",
      }),
      mode: 0o600,
      path: Output.interpolate`${bucket.configuration}/proof.env`,
    });
  });

test.provider(
  "reference graph persists only names and digests through Alchemy encoding",
  (scratch) =>
    Effect.gen(function* stateSafety() {
      const stack = checkedStack(scratch);
      yield* stack.deploy(graph(false));
      const state = yield* yield* State;

      const ids = yield* state.list({
        stack: scratch.name,
        stage: scratch.stage,
      });

      const rows = yield* Effect.forEach((fqn: string) =>
        state.get({ fqn, stack: scratch.name, stage: scratch.stage })
      )(ids);

      const encoded = JSON.stringify(encodeState(rows));

      expect(ids).not.toContain("store/access-key");
      expect(ids).not.toContain("store/secret-key");
      expect(encoded).not.toContain("__redacted__");
      expect(encoded).toContain(credentialNames.accessKey);
      expect(encoded).toContain(credentialNames.secretKey);

      for (const value of Object.values(values)) {
        expect(encoded).not.toContain(value);
        expect(encoded).not.toContain(JSON.stringify(value).slice(1, -1));
      }

      const { files } = yield* SecretRendered;
      const identity = files.get(`${host.home}/.config/rat-king/s3.json`) ?? "";

      const environment =
        files.get(`${host.home}/.config/rat-king/celld.env`) ?? "";

      expect(JSON.parse(identity)).toEqual({
        identities: [
          {
            actions: ["Admin", "Read", "Write", "List", "Tagging"],
            credentials: [
              {
                accessKey: values[credentialNames.accessKey],
                secretKey: values[credentialNames.secretKey],
              },
            ],
            name: "rat-king",
          },
        ],
      });
      expect(environment).toContain("AWS_ACCESS_KEY_ID=");

      for (const text of files.values()) {
        if (text.includes("fixture-secret")) {
          expect(encoded).not.toContain(text);
        }
      }

      const plan = yield* stack.plan(graph(false));
      expect(
        Object.values(plan.resources).every(({ action }) => action === "noop")
      ).toBe(true);
    })
);

test.provider(
  "explicit legacy graph preserves today's Random state shape without replacement",
  (scratch) =>
    Effect.gen(function* legacyPlan() {
      const stack = checkedStack(scratch);
      yield* stack.deploy(graph(true));
      const state = yield* yield* State;

      const rows = yield* Effect.forEach(
        [
          "store/access-key",
          "store/secret-key",
          "store/identity",
          "celld/environment",
        ],
        (fqn) => state.get({ fqn, stack: scratch.name, stage: scratch.stage })
      );

      expect(JSON.stringify(encodeState(rows))).toContain("__redacted__");
      expect(
        JSON.stringify(encodeState(Redacted.make("a".repeat(32))))
      ).toContain("a".repeat(32));
      const plan = yield* stack.plan(graph(true));
      expect(plan.deletions).toEqual({});
      expect(
        Object.values(plan.resources).every(({ action }) => action === "noop")
      ).toBe(true);
    })
);
