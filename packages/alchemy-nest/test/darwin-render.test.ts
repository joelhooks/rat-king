import * as Test from "@alchemy.run/test/Vitest";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { Context, Effect, Layer } from "effect";
import { expect } from "vitest";

import { LocalBucket } from "../src/darwin-bucket.ts";
import { DarwinInstance } from "../src/darwin-instance.ts";
import type { DarwinInstanceProps } from "../src/darwin-instance.ts";
import { LaunchdService } from "../src/darwin.ts";
import { resolveFileContent } from "../src/file-content.ts";
import { textDigest } from "../src/files.ts";
import { launchdPath, renderPlist } from "../src/launchd-plist.ts";
import { HostDirectory, RemoteFile } from "../src/providers.ts";
import { SecretSource } from "../src/secret-source.ts";
import { checkedStack } from "./checked-stack.ts";

class Rendered extends Context.Service<
  Rendered,
  {
    readonly plists: Map<string, string>;
    readonly files: Map<string, string>;
    readonly deleted: string[];
  }
>()("Test/DarwinRendered") {}

const values = {
  "example-access": "invented-private-access-value",
  "example-secret": "invented-private-secret-value",
  "example-token": "invented-private-token-value-at-least-32",
};

const props: DarwinInstanceProps = {
  binaries: {
    celld: "/srv/example/bin/celld",
    environmentLauncher: "/srv/example/bin/environment.mjs",
    node: "/srv/example/bin/node",
    sliceService: "/srv/example/bin/slice.mjs",
    weed: "/srv/example/bin/weed",
  },
  bucket: "example-archive",
  countLookbackDays: 30,
  credentials: {
    accessKey: "example-access",
    secretKey: "example-secret",
    sliceToken: "example-token",
  },
  labelPrefix: "org.example.archive",
  launchAgents: "/srv/example/agents",
  ports: {
    filer: 31_007,
    filerGrpc: 31_008,
    internal: 31_001,
    master: 31_003,
    masterGrpc: 31_004,
    public: 31_000,
    s3: 31_009,
    s3Grpc: 31_010,
    slice: 31_002,
    volume: 31_005,
    volumeGrpc: 31_006,
  },
  root: "/srv/example/archive",
  sessionsDatabase: "/srv/example/sessions.db",
  uid: 501,
};

const files = Provider.effect(
  RemoteFile,
  Effect.gen(function* provider() {
    const source = yield* SecretSource;
    const rendered = yield* Rendered;

    return RemoteFile.Provider.of({
      delete: ({ output }) =>
        Effect.sync(() => {
          rendered.deleted.push(output?.path ?? "file");
        }),
      list: () => Effect.succeed([]),
      read: ({ output }) => Effect.succeed(output),
      reconcile: Effect.fn("Test.Darwin.file")(function* reconcile({ news }) {
        const text = yield* resolveFileContent(news).pipe(
          Effect.provideService(SecretSource, source)
        );

        rendered.files.set(news.path, text);

        const attr = {
          mode: news.mode ?? 0o600,
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

const launchd = Provider.effect(
  LaunchdService,
  Effect.gen(function* provider() {
    const rendered = yield* Rendered;

    return LaunchdService.Provider.of({
      delete: ({ output }) =>
        Effect.sync(() => {
          rendered.deleted.push(output?.path ?? "agent");
        }),
      list: () => Effect.succeed([]),
      read: ({ output }) => Effect.succeed(output),
      reconcile: ({ news }) =>
        Effect.sync(() => {
          const text = renderPlist(news);
          rendered.plists.set(news.label, text);

          return {
            deleteOnRemove: false,
            label: news.label,
            labelPrefix: news.labelPrefix,
            path: launchdPath(news),
            pid: 100,
            sha256: textDigest(text),
            uid: news.uid,
          };
        }),
    });
  })
);

const directory = Provider.succeed(HostDirectory, {
  delete: () => Effect.die("Retained directory deletion reached provider."),
  list: () => Effect.succeed([]),
  read: ({ output }) => Effect.succeed(output),
  reconcile: ({ news }) =>
    Effect.succeed({ mode: news.mode ?? 0o700, path: news.path }),
});

const bucket = Provider.succeed(LocalBucket, {
  delete: () => Effect.die("Retained bucket deletion reached provider."),
  list: () => Effect.succeed([]),
  read: ({ output }) => Effect.succeed(output),
  reconcile: ({ news }) =>
    Effect.succeed({
      config: news.config,
      endpoint: news.endpoint,
      name: news.name,
    }),
});

const { test } = Test.make({
  providers: Layer.mergeAll(files, launchd, directory, bucket).pipe(
    Layer.provideMerge(
      Layer.sync(Rendered, () => ({
        deleted: [],
        files: new Map<string, string>(),
        plists: new Map<string, string>(),
      }))
    ),
    Layer.provide(SecretSource.fromRecord(values))
  ),
  stage: "darwin-render",
});

test.provider(
  "Darwin graph retains data and persists secret references, never secret values in state or plists",
  (scratch) =>
    Effect.gen(function* verify() {
      const stack = checkedStack(scratch);
      yield* stack.deploy(DarwinInstance("example", props));
      const state = yield* yield* State;

      const ids = yield* state.list({
        stack: scratch.name,
        stage: scratch.stage,
      });

      const rows = yield* Effect.forEach((fqn: string) =>
        state.get({ fqn, stack: scratch.name, stage: scratch.stage })
      )(ids);

      const encoded = JSON.stringify(encodeState(rows));
      const rendered = yield* Rendered;
      expect(rendered.plists.size).toBe(3);
      expect(rendered.files.get(`${props.root}/filer.toml`)).toContain(
        `dir = ${JSON.stringify(`${props.root}/filer-db`)}`
      );

      for (const name of ["master", "security", "notification"]) {
        expect(rendered.files.get(`${props.root}/${name}.toml`)).toBe("\n");
      }

      for (const value of Object.values(values)) {
        expect(encoded).not.toContain(value);

        for (const plist of rendered.plists.values()) {
          expect(plist).not.toContain(value);
        }
      }

      expect(encoded).toContain("example-secret");
      expect(encoded).toContain('"retain"');
      expect(rendered.plists.get(`${props.labelPrefix}.node`)).toContain(
        "127.0.0.1:31000"
      );
      expect(rendered.plists.get(`${props.labelPrefix}.slice`)).toContain(
        "SLICE_COUNT_LOOKBACK_DAYS"
      );
      yield* stack.destroy();
      expect(rendered.deleted).toEqual([]);
    })
);
