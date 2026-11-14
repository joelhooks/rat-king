import * as Test from "@alchemy.run/test/Vitest";
import { NodePath } from "@effect/platform-node";
import { offlineLayer } from "@rat-king/alchemy-nest/offline";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import { Celld, ObjectStore } from "../src/index.ts";
import { ReleaseSource } from "../src/release.ts";
import { checkedStack } from "./checked-stack.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const { test } = Test.make({
  providers: Layer.merge(ObjectStore.providers(), Celld.providers()).pipe(
    Layer.provide(offlineLayer),
    Layer.provide(NodePath.layer),
    Layer.provide(
      Layer.succeed(ReleaseSource, {
        get: () => Effect.die("Offline plan must not download"),
      })
    )
  ),
  stage: "restart-gate-off",
});

const single = (gate: { readonly restartGate?: false }) =>
  Effect.gen(function* singleNode() {
    const instance = "single";
    const portBase = 31_440;

    const slice = yield* ObjectStore.Slice({
      home: host.home,
      instance,
      memoryMax: "3G",
    });

    const bucket = yield* ObjectStore.Bucket("store", {
      dataRoot: "/srv/example/single",
      host,
      instance,
      legacyRandomCredentials: true,
      name: "single-cells",
      portBase,
      ...gate,
      slice: slice.sha256,
    });

    return yield* Celld.Node("celld", { bucket, host, instance, portBase });
  });

test.provider(
  "a named instance with the restart gate off plans no gate file or hooks",
  (scratch) =>
    Effect.gen(function* off() {
      const plan = yield* checkedStack(scratch).plan(
        single({ restartGate: false })
      );

      const text = JSON.stringify(plan.resources);

      expect(text).toContain("single-celld.service");
      expect(text).not.toContain("restart-gate");
    })
);

test.provider("a named instance keeps its restart gate by default", (scratch) =>
  Effect.gen(function* on() {
    const plan = yield* checkedStack(scratch).plan(single({}));

    expect(JSON.stringify(plan.resources)).toContain("restart-gate");
  })
);
