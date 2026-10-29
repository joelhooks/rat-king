import { NodePath } from "@effect/platform-node";
import { offlineLayer } from "@rat-king/alchemy-nest/offline";
import * as Test from "alchemy/Test/Vitest";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import { celldMemoryMax } from "../../../stacks/nest/config.ts";
import { fleetMemoryLimits } from "../../../stacks/nest/stop-memory.ts";
import { Celld, ObjectStore } from "../src/index.ts";
import { NodeSchema } from "../src/inventory-schema.ts";
import type { Node } from "../src/inventory-schema.ts";
import { ReleaseSource } from "../src/release.ts";
import { renderUnit, UnitSchema } from "../src/systemd.ts";
import { checkedStack } from "./checked-stack.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const plannedUnit = Schema.Struct({
  props: Schema.Struct({
    home: UnitSchema.fields.home,
    name: UnitSchema.fields.name,
    scope: UnitSchema.fields.scope,
    sections: UnitSchema.fields.sections,
  }),
});

const mailboxServices = (node: Node) =>
  Effect.gen(function* declareMailbox() {
    const slice = yield* ObjectStore.Slice(node.home, fleetMemoryLimits.slice);

    const bucket = yield* ObjectStore.Bucket("store", {
      host: node,
      legacyRandomCredentials: true,
      memoryMax: fleetMemoryLimits.seaweedfs,
      name: "example-cells",
      slice: slice.sha256,
      volumeMax: 2048,
    });

    return yield* Celld.Node("celld", {
      bucket,
      host: node,
      memoryMax: celldMemoryMax(node),
    });
  });

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
  stage: "celld-cgroup-plan-tests",
});

for (const privateView of [false, true]) {
  test.provider(
    privateView
      ? "opt-in inventory scopes the celld cgroup and its 5G limit"
      : "default inventory preserves the existing 8G celld plan",
    (scratch) =>
      Effect.gen(function* cgroupPlan() {
        const node = yield* Schema.decodeEffect(NodeSchema)(
          privateView
            ? { ...host, celldMemoryMax: "5G", privateCgroupView: true }
            : host
        );

        const plan = yield* checkedStack(scratch).plan(mailboxServices(node));

        const resources = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
        )(JSON.stringify(plan.resources));

        const declaration = yield* Schema.decodeUnknownEffect(plannedUnit)(
          resources["celld/node"]
        );

        const unit = renderUnit(declaration.props);

        expect(unit.includes("ProtectControlGroups=private\n")).toBe(
          privateView
        );
        expect(unit).toContain(`MemoryMax=${privateView ? "5G" : "8G"}\n`);
        expect(unit).not.toContain("PrivateUsers=");
        expect(unit).not.toContain("PrivateNetwork=");
        expect(unit).toMatchSnapshot();
      })
  );
}
