import { NodeServices } from "@effect/platform-node";
import * as Test from "alchemy/Test/Vitest";
import { Config, Crypto, Effect, Layer } from "effect";
import { expect } from "vitest";

import { HostShell, must } from "../src/host-shell.ts";
import { Host, layer as inventoryLayer } from "../src/host.ts";
import { SystemdUnit, SystemdUnitProvider } from "../src/providers.ts";
import { layer as sshLayer } from "../src/ssh.ts";
import { deleteUnit, reconcileUnit, unitPath } from "../src/systemd.ts";
import type { UnitAttributes, UnitProps } from "../src/systemd.ts";
import { checkedStack } from "./checked-stack.ts";
import { service } from "./fixtures.ts";

const hostLayer = inventoryLayer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.orDie
);

const connection = Layer.unwrap(
  Effect.gen(function* connect() {
    const inventory = yield* Host;
    const alias = yield* Config.String("RAT_KING_LIVE_NODE");

    return sshLayer(yield* inventory.node(alias));
  })
).pipe(
  Layer.provideMerge(hostLayer),
  Layer.provide(NodeServices.layer),
  Layer.orDie
);

const { test } = Test.make({
  adopt: true,
  providers: SystemdUnitProvider().pipe(Layer.provideMerge(connection)),
  stage: "user-unit-live-test",
});

const cleanupAttributes = (props: UnitProps): UnitAttributes => ({
  active: false,
  configSha256: "",
  enabled: false,
  home: props.home,
  name: props.name,
  needDaemonReload: false,
  path: unitPath(props),
  scope: "user",
  sha256: "",
});

test.provider.skipIf(
  process.env.RAT_KING_LIVE_NODE === undefined ||
    process.env.RAT_KING_LIVE_NODE === ""
)(
  "live user unit create/update/adopt/delete and zero leftover probe",
  (scratch) =>
    Effect.gen(function* live() {
      const stack = checkedStack(scratch);

      const shell = yield* HostShell;
      const inventory = yield* Host;

      const node = yield* inventory.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      const crypto = yield* Crypto.Crypto;
      const name = `rat-king-test-${yield* crypto.randomUUIDv4}.service`;
      const props = service(node.home, name);
      expect(yield* shell.stat(unitPath(props))).toBeUndefined();

      const slice: UnitProps = {
        home: node.home,
        name: "rat-king.slice",
        scope: "user",
        sections: [
          {
            lines: [
              ["MemoryMax", "4G"],
              ["MemorySwapMax", "0"],
              ["CPUQuota", "300%"],
              ["TasksMax", "2048"],
            ],
            name: "Slice",
          },
        ],
      };

      const sliceExists = (yield* shell.stat(unitPath(slice))) !== undefined;

      const run = Effect.gen(function* lifecycle() {
        if (!sliceExists) {
          yield* reconcileUnit(shell, slice, undefined, false);
        }

        const created = yield* stack
          .deploy(SystemdUnit("test-unit", props))
          .pipe(Effect.orDie);

        expect(created.active).toBe(true);
        expect(
          yield* must(shell, [
            "systemctl",
            "--user",
            "show",
            name,
            "--property=MemoryMax",
            "--value",
          ])
        ).toBe("67108864\n");
        expect(
          yield* must(shell, [
            "systemctl",
            "--user",
            "show",
            name,
            "--property=CPUQuotaPerSecUSec",
            "--value",
          ])
        ).toBe("100ms\n");
        const next = service(node.home, name, "60M");

        const updated = yield* stack
          .deploy(SystemdUnit("test-unit", next))
          .pipe(Effect.orDie);

        expect(updated.sha256).not.toBe(created.sha256);
        expect(
          yield* must(shell, [
            "systemctl",
            "--user",
            "show",
            name,
            "--property=MemoryMax",
            "--value",
          ])
        ).toBe("62914560\n");
        yield* stack.destroy().pipe(Effect.orDie);
        yield* reconcileUnit(shell, next, undefined, false);

        const pid = yield* must(shell, [
          "systemctl",
          "--user",
          "show",
          name,
          "--property=MainPID",
          "--value",
        ]);

        const adopted = yield* stack
          .deploy(SystemdUnit("test-unit", next))
          .pipe(Effect.orDie);

        expect(adopted.active).toBe(true);
        expect(
          yield* must(shell, [
            "systemctl",
            "--user",
            "show",
            name,
            "--property=MainPID",
            "--value",
          ])
        ).toBe(pid);

        const plan = yield* stack
          .plan(SystemdUnit("test-unit", next))
          .pipe(Effect.orDie);

        expect(
          Object.values(plan.resources).map((resource) => resource.action)
        ).toEqual(["noop"]);
        yield* stack.destroy().pipe(Effect.orDie);
      });

      yield* run.pipe(
        Effect.ensuring(
          Effect.gen(function* cleanup() {
            yield* stack.destroy().pipe(Effect.orDie);
            yield* deleteUnit(shell, cleanupAttributes(props));

            if (!sliceExists) {
              yield* deleteUnit(shell, cleanupAttributes(slice));
            }
          }).pipe(Effect.orDie)
        )
      );
      expect(
        yield* must(shell, [
          "systemctl",
          "--user",
          "list-units",
          "--all",
          "--no-legend",
          "--no-pager",
          "rat-king-test-*",
        ])
      ).toBe("");

      const unitFiles = yield* must(shell, [
        "systemctl",
        "--user",
        "list-unit-files",
        "--no-legend",
        "--no-pager",
      ]);

      expect(
        unitFiles
          .split("\n")
          .filter((line) => line.startsWith("rat-king-test-"))
      ).toEqual([]);
      expect(
        yield* must(shell, [
          "find",
          `${node.home}/.config/systemd/user`,
          "-maxdepth",
          "1",
          "-name",
          "rat-king-test-*",
          "-print",
        ])
      ).toBe("");
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 240_000 }
);
