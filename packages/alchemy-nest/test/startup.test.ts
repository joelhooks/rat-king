import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Result, Schema } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { testLayer } from "../src/host-shell.ts";
import { assessListeners, readListeners } from "../src/listeners.ts";
import { startupLayer, stopUnit } from "../src/startup-contract.ts";
import { UnitStartup } from "../src/unit-startup.ts";

const key = ({
  unit,
  bind,
  port,
}: {
  unit: string;
  bind: string;
  port: number;
}) => `${unit}|${bind}|${port}`;

const address = "203.0.113.10";

const storeUnit = "rat-king-seaweedfs.service";

const nodeUnit = "rat-king-celld.service";

const sidecarUnit = "rat-king-claude-sidecar.service";

const cgroup = (unit: string, uid = 1000) =>
  `/user.slice/user-${uid}.slice/user@${uid}.service/rat.slice/rat-king.slice/${unit}`;

const observedCgroup = (unit: string): string => {
  if (unit === "missing") {
    return "";
  }

  if (unit === "sshd.service") {
    return "/system.slice/sshd.service";
  }

  if (unit === "foreign-user") {
    return cgroup(storeUnit, 1001);
  }

  return cgroup(unit);
};

const unitCgroups = new Map(
  [storeUnit, nodeUnit, sidecarUnit].map((unit) => [unit, cgroup(unit)])
);

const line = (
  port: number,
  unit = storeUnit,
  bind = "127.0.0.1",
  process = "anything"
) =>
  `LISTEN 0 4096 ${bind}:${port} 0.0.0.0:* users:(("${process}",pid=12,fd=3)) cgroup:${cgroup(unit)}`;

const ports = [19_333, 18_081, 18_888, 18_333, 29_333, 28_081, 28_888, 28_333];

const store = ports.map((port) => line(port)).join("\n");

const complete = `${store}\n${line(18_788, nodeUnit)}\n${line(18_787, nodeUnit, address)}`;

it("requires exact unit, interface and port sets", () => {
  expect(assessListeners(store, address, false, false, unitCgroups)._tag).toBe(
    "Ready"
  );
  expect(
    assessListeners(complete, address, true, false, unitCgroups)._tag
  ).toBe("Ready");
  expect(assessListeners(store, address, true, false, unitCgroups)._tag).toBe(
    "Waiting"
  );

  for (const extra of [8181, 9101]) {
    expect(
      assessListeners(
        `${store}\n${line(extra)}`,
        address,
        false,
        false,
        unitCgroups
      )._tag
    ).toBe("Violation");
  }

  expect(
    assessListeners(
      complete.replace("127.0.0.1:18788", "0.0.0.0:18788"),
      address,
      true,
      false,
      unitCgroups
    )._tag
  ).toBe("Violation");
  expect(
    assessListeners(
      complete.replace(cgroup(nodeUnit), cgroup(storeUnit)),
      address,
      true,
      false,
      unitCgroups
    )._tag
  ).toBe("Violation");
  expect(
    assessListeners(
      `${complete}\n${line(18_333)}`,
      address,
      true,
      false,
      unitCgroups
    )._tag
  ).toBe("Violation");
});

it("requires the sidecar as the eleventh listener and rejects its extra ports", () => {
  const full = `${complete}\n${line(18_789, sidecarUnit, "127.0.0.1", "MainThread")}`;
  expect(assessListeners(full, address, true, true, unitCgroups)._tag).toBe(
    "Ready"
  );
  expect(assessListeners(complete, address, true, true, unitCgroups)._tag).toBe(
    "Waiting"
  );
  expect(assessListeners(full, address, true, false, unitCgroups)._tag).toBe(
    "Violation"
  );
  expect(
    assessListeners(
      `${full}\n${line(19_001, sidecarUnit)}`,
      address,
      true,
      true,
      unitCgroups
    )._tag
  ).toBe("Violation");
  expect(
    assessListeners(
      full.replace("127.0.0.1:18789", "0.0.0.0:18789"),
      address,
      true,
      true,
      unitCgroups
    )._tag
  ).toBe("Violation");
});

it.prop(
  "only the declared unit/address/port set passes, independently of process names and PIDs",
  {
    extras: Arbitrary.schema(
      Schema.Array(
        Schema.Struct({
          bind: Schema.Literals([
            "127.0.0.1",
            address,
            "0.0.0.0",
            "[::]",
            [192, 168, 1, 20].join("."),
            "[::1]",
          ]),
          port: Schema.Literals([...ports, 18_787, 18_788, 18_789, 22, 9101]),
          unit: Schema.Literals([
            storeUnit,
            nodeUnit,
            sidecarUnit,
            "rat-king-unknown.service",
            "sshd.service",
            "foreign-user",
            "missing",
          ]),
        })
      )
    ),
    full: Arbitrary.schema(Schema.Boolean),
    included: Arbitrary.schema(
      Schema.Array(
        Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 }))
      )
    ),
    node: Arbitrary.schema(Schema.Boolean),
    pid: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }))
    ),
    process: Arbitrary.schema(
      Schema.Literals([
        "weed",
        "celld",
        "node",
        "MainThread",
        "sshd",
        "rat-king",
        "other",
      ])
    ),
    sidecar: Arbitrary.schema(Schema.Boolean),
  },
  ({ node, sidecar, full, included, extras, process, pid }) => {
    const allowed = [
      ...ports.map((port) => ({ bind: "127.0.0.1", port, unit: storeUnit })),
      ...(node
        ? [
            { bind: address, port: 18_787, unit: nodeUnit },
            { bind: "127.0.0.1", port: 18_788, unit: nodeUnit },
          ]
        : []),
      ...(sidecar
        ? [{ bind: "127.0.0.1", port: 18_789, unit: sidecarUnit }]
        : []),
    ];

    const listeners = [
      ...allowed.filter((_, index) => full || included.includes(index)),
      ...extras,
    ];

    const reserved = new Set([...ports, 18_787, 18_788, 18_789]);

    const scoped = listeners.filter(
      ({ unit, port }) =>
        unit.startsWith("rat-king-") ||
        unit === "foreign-user" ||
        reserved.has(port)
    );

    const allowedKeys = new Set(allowed.map(key));
    const seen = new Set(scoped.map(key));

    const violation =
      scoped.some((listener) => !allowedKeys.has(key(listener))) ||
      seen.size !== scoped.length;

    const accepted = seen.size === allowedKeys.size ? "Ready" : "Waiting";
    const expected = violation ? "Violation" : accepted;

    const output = listeners
      .map(({ unit, bind, port }) => {
        const path = observedCgroup(unit);

        return line(port, unit, bind, process)
          .replace(
            `cgroup:${cgroup(unit)}`,
            path === "" ? "" : `cgroup:${path}`
          )
          .replace("pid=12", `pid=${pid}`);
      })
      .join("\n");

    expect(
      assessListeners(output, address, node, sidecar, unitCgroups)._tag
    ).toBe(expected);
  }
);

it.effect(
  "reads exact user-unit cgroups and requests cgroup listener evidence",
  () =>
    Effect.gen(function* testCgroups() {
      const fake = yield* makeFakeShell();
      const commands: (readonly string[])[] = [];

      const shell = {
        ...fake.shell,
        exec: (argv: readonly string[]) => {
          commands.push(argv);

          return Effect.succeed({
            code: 0,
            stdout: argv[0] === "ss" ? complete : `${cgroup(argv[3] ?? "")}\n`,
          });
        },
      };

      const observed = yield* readListeners(shell);
      expect(
        assessListeners(
          observed.text,
          address,
          true,
          false,
          observed.unitCgroups
        )._tag
      ).toBe("Ready");
      expect(commands).toEqual([
        ...[storeUnit, nodeUnit, sidecarUnit].map((unit) => [
          "systemctl",
          "--user",
          "show",
          unit,
          "--property=ControlGroup",
          "--value",
        ]),
        ["ss", "-H", "-ltnp", "--cgroup"],
      ]);
    })
);

it.effect.prop(
  "stops both units and preserves the startup violation even if cleanup fails",
  { stopFails: Arbitrary.schema(Schema.Boolean) },
  ({ stopFails }) =>
    Effect.gen(function* testStop() {
      const fake = yield* makeFakeShell();
      const stopped: string[][] = [];

      const shell = {
        ...fake.shell,
        exec: (argv: readonly string[]) => {
          if (argv[0] === "ss") {
            return Effect.succeed({
              code: 0,
              stdout: `${complete}\n${line(9101)}`,
            });
          }

          if (
            argv[0] === "systemctl" &&
            argv.includes("--property=ControlGroup")
          ) {
            return Effect.succeed({ code: 0, stdout: cgroup(argv[3] ?? "") });
          }

          if (argv[0] === "systemctl" && argv[2] === "stop") {
            stopped.push(argv.slice(3));

            return Effect.succeed({ code: stopFails ? 7 : 0, stdout: "" });
          }

          if (
            argv[0] === "systemctl" &&
            argv.includes("--property=LoadState")
          ) {
            return Effect.succeed({ code: 0, stdout: "LoadState=loaded" });
          }

          return fake.shell.exec(argv);
        },
      };

      yield* Effect.gen(function* invoke() {
        const startup = yield* UnitStartup;

        const result = yield* Effect.result(
          startup.afterStart("rat-king-celld.service")
        );

        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(result.failure.reason).toContain(
            "Startup listener contract violated"
          );
        }

        expect(stopped).toEqual([
          ["rat-king-celld.service"],
          ["rat-king-seaweedfs.service"],
        ]);
      }).pipe(
        Effect.provide(
          startupLayer(address).pipe(
            Layer.provide(testLayer(shell)),
            Layer.provide(NodeServices.layer)
          )
        )
      );
    })
);

it.effect.prop(
  "failed stop is tolerated only with a successful exact-unit not-found readback",
  {
    load: Arbitrary.schema(
      Schema.Literals(["not-found", "loaded", "masked", "error"])
    ),
    readFails: Arbitrary.schema(Schema.Boolean),
  },
  ({ load, readFails }) =>
    Effect.gen(function* checkAbsence() {
      const fake = yield* makeFakeShell();
      const observed: string[][] = [];

      const shell = {
        ...fake.shell,
        exec: (argv: readonly string[]) => {
          observed.push([...argv]);

          return Effect.succeed(
            argv[2] === "stop"
              ? { code: 5, stdout: "" }
              : { code: readFails ? 1 : 0, stdout: `LoadState=${load}` }
          );
        },
      };

      const result = yield* stopUnit(shell, "example.service").pipe(
        Effect.result
      );

      expect(Result.isSuccess(result)).toBe(!readFails && load === "not-found");
      expect(observed).toEqual([
        ["systemctl", "--user", "stop", "example.service"],
        [
          "systemctl",
          "--user",
          "show",
          "example.service",
          "--property=LoadState",
        ],
      ]);
    })
);
