import { NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { textDigest } from "../src/files.ts";
import { operatorBundle } from "../src/operator-build.ts";
import { nodeUnit, storeUnit } from "../src/service-units.ts";
import { renderUnit } from "../src/systemd.ts";

it.live("mailbox restart gate pins Effect 4.0.5 bundle bytes", () =>
  Effect.gen(function* baseline() {
    const bundle = yield* operatorBundle(
      new URL("../../../stacks/nest/restart-gate.ts", import.meta.url).pathname
    );

    expect(textDigest(bundle)).toBe(
      "ca6d4c496631353ef6c7fd8711c5f2521e4e8367621b7acbfaf4aa0b2af63bf7"
    );
  }).pipe(Effect.provide(NodePath.layer))
);

it("gated mailbox units keep main 920884e bytes", () => {
  const host = {
    dataRoot: "/srv/example/mailbox",
    home: "/home/example",
    ssh: "example",
    tailnetIPv4: "203.0.113.10",
  };

  const restartGate = {
    address: host.tailnetIPv4,
    path: `${host.home}/.local/share/rat-king/bin/restart-gate.mjs`,
  };

  const node = nodeUnit({
    binary: `${host.home}/.local/share/rat-king/bin/celld`,
    data: `${host.dataRoot}/celld`,
    environment: `${host.home}/.config/rat-king/celld.env`,
    host,
    restartGate,
    restartOn: [],
    storageDiagnostic: `${host.home}/.local/share/rat-king/bin/storage-maintenance.py`,
  });

  const store = storeUnit({
    binary: `${host.home}/.local/share/rat-king/bin/weed`,
    config: `${host.home}/.config/rat-king/s3.json`,
    data: `${host.dataRoot}/seaweedfs`,
    home: host.home,
    restartGate,
    restartOn: [],
  });

  expect({
    node: textDigest(renderUnit(node)),
    store: textDigest(renderUnit(store)),
  }).toMatchSnapshot();
});
