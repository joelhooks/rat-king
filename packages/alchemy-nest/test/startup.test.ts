import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Predicate, Result, Schema } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { testLayer } from "../src/host-shell.ts";
import { verifiedSidecarPid } from "../src/listeners.ts";
import {
  assessListeners,
  startupLayer,
  stopUnit,
} from "../src/startup-contract.ts";
import { UnitStartup } from "../src/unit-startup.ts";

const address = "203.0.113.10";

const line = (port: number, process = "weed", bind = "127.0.0.1") =>
  `LISTEN 0 4096 ${bind}:${port} 0.0.0.0:* users:(("${process}",pid=12,fd=3))`;

const store = [19_333, 18_081, 18_888, 18_333, 29_333, 28_081, 28_888, 28_333]
  .map((port) => line(port))
  .join("\n");

const complete = `${store}\n${line(18_788, "celld")}\n${line(18_787, "celld", address)}`;

it("requires exact process, interface and port sets", () => {
  expect(
    Predicate.isTagged(assessListeners(store, address, false), "Ready")
  ).toBe(true);
  expect(
    Predicate.isTagged(assessListeners(complete, address, true), "Ready")
  ).toBe(true);
  expect(
    Predicate.isTagged(assessListeners(store, address, true), "Waiting")
  ).toBe(true);

  for (const extra of [8181, 9101]) {
    expect(
      Predicate.isTagged(
        assessListeners(`${store}\n${line(extra)}`, address, false),
        "Violation"
      )
    ).toBe(true);
  }

  expect(
    Predicate.isTagged(
      assessListeners(
        complete.replace("127.0.0.1:18788", "0.0.0.0:18788"),
        address,
        true
      ),
      "Violation"
    )
  ).toBe(true);
  expect(
    Predicate.isTagged(
      assessListeners(complete.replace('"celld"', '"weed"'), address, true),
      "Violation"
    )
  ).toBe(true);
  expect(
    Predicate.isTagged(
      assessListeners(`${complete}\n${line(18_333)}`, address, true),
      "Violation"
    )
  ).toBe(true);
});

it("requires the sidecar as the eleventh listener and rejects its extra ports", () => {
  const sidecar = line(18_789, "node");
  const full = `${complete}\n${sidecar}`;
  expect(assessListeners(full, address, true, true, "12")._tag).toBe("Ready");
  expect(assessListeners(complete, address, true, true)._tag).toBe("Waiting");
  expect(assessListeners(full, address, true, false)._tag).toBe("Violation");
  expect(
    assessListeners(
      `${full}\n${line(19_001, "node")}`,
      address,
      true,
      true,
      "12"
    )._tag
  ).toBe("Violation");
  expect(
    assessListeners(
      full.replace("127.0.0.1:18789", "0.0.0.0:18789"),
      address,
      true,
      true,
      "12"
    )._tag
  ).toBe("Violation");
});

it.effect(
  "accepts Linux MainThread only for the unit PID and approved executable",
  () =>
    Effect.gen(function* testLinuxIdentity() {
      const fake = yield* makeFakeShell();
      const full = `${complete}\n${line(18_789, "MainThread")}`;

      for (const approved of [true, false]) {
        const shell = {
          ...fake.shell,
          exec: (argv: readonly string[]) => {
            if (argv[0] === "systemctl" && argv.includes("MainPID")) {
              return Effect.succeed({ code: 0, stdout: "12\n" });
            }

            if (argv[0] === "readlink") {
              return Effect.succeed({
                code: 0,
                stdout:
                  argv[2] === "/usr/local/bin/node" || approved
                    ? "/opt/example/node\n"
                    : "/opt/example/not-node\n",
              });
            }

            return fake.shell.exec(argv);
          },
        };

        const pid = yield* verifiedSidecarPid(shell);

        expect(pid).toBe(approved ? "12" : undefined);
        expect(assessListeners(full, address, true, true, pid)._tag).toBe(
          approved ? "Ready" : "Violation"
        );
      }

      for (const changed of [
        full.replace('"MainThread",pid=12', '"MainThread",pid=13'),
        full.replace("127.0.0.1:18789", "0.0.0.0:18789"),
        `${full}\n${line(19_001, "MainThread")}`,
        full.replace(
          '"MainThread",pid=12,fd=3))',
          '"MainThread",pid=12,fd=3),("node",pid=13,fd=4))'
        ),
      ]) {
        expect(assessListeners(changed, address, true, true, "12")._tag).toBe(
          "Violation"
        );
      }
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
