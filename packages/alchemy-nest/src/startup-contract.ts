import type { Crypto, FileSystem } from "effect";
import { Effect, Layer, Predicate, Schema } from "effect";

import { refuse } from "./files.ts";
import { HostShell, must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { assessListeners } from "./listeners.ts";
import { bootstrapProbe, probeEnvironment } from "./probes.ts";
import { s3Script } from "./s3-script.ts";
import { UnitStartup } from "./unit-startup.ts";

export { assessListeners } from "./listeners.ts";

const stopBoth = Effect.fn("UnitStartup.stopBoth")(function* stop(
  shell: Interface
) {
  yield* must(shell, [
    "systemctl",
    "--user",
    "stop",
    "rat-king-celld.service",
    "rat-king-seaweedfs.service",
  ]);

  if (
    (yield* shell.exec([
      "systemctl",
      "--user",
      "is-active",
      "rat-king-claude-sidecar.service",
    ])).code === 0
  ) {
    yield* must(shell, [
      "systemctl",
      "--user",
      "stop",
      "rat-king-claude-sidecar.service",
    ]);
  }
});

const assertStarted = Effect.fn("UnitStartup.assertStarted")(function* check(
  shell: Interface,
  publicIPv4: string,
  nodeExpected: boolean,
  sidecarExpected: boolean
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const assessment = assessListeners(
      yield* must(shell, ["ss", "-ltnp"]),
      publicIPv4,
      nodeExpected,
      sidecarExpected
    );

    if (Predicate.isTagged(assessment, "Ready")) {
      yield* Effect.log("STARTUP_LISTENERS_PASSED", assessment.receipt);

      return yield* Effect.void;
    }

    if (Predicate.isTagged(assessment, "Violation")) {
      return yield* refuse(
        `Startup listener contract violated; both units must stop.\n${assessment.receipt}`
      );
    }

    yield* Effect.sleep("250 millis");
  }

  return yield* refuse(
    "Startup listener deadline exceeded; both units must stop."
  );
});

const Pointer = Schema.Struct({
  status: Schema.Int,
  version: Schema.String,
});

export const startupLayer = (publicIPv4: string) =>
  Layer.effect(
    UnitStartup,
    Effect.gen(function* startup() {
      const shell = yield* HostShell;

      const context = yield* Effect.context<
        Crypto.Crypto | FileSystem.FileSystem
      >();

      return {
        afterStart: (name: string) => {
          if (
            name !== "rat-king-seaweedfs.service" &&
            name !== "rat-king-celld.service" &&
            name !== "rat-king-claude-sidecar.service"
          ) {
            return Effect.void;
          }

          return Effect.gen(function* checkStarted() {
            const active = (unit: string) =>
              shell.exec(["systemctl", "--user", "is-active", unit]);

            const nodeActive =
              (yield* active("rat-king-celld.service")).code === 0;

            const sidecarActive =
              (yield* active("rat-king-claude-sidecar.service")).code === 0;

            yield* assertStarted(
              shell,
              publicIPv4,
              name !== "rat-king-seaweedfs.service" || nodeActive,
              name === "rat-king-claude-sidecar.service" || sidecarActive
            );
          }).pipe(Effect.onError(() => stopBoth(shell).pipe(Effect.orDie)));
        },
        beforeStart: (name: string, home: string) => {
          if (name !== "rat-king-celld.service") {
            return Effect.void;
          }

          return Effect.gen(function* seed() {
            const environment = yield* probeEnvironment(shell, home);

            const result = yield* shell.exec(
              [
                "python3",
                "-c",
                s3Script,
                `${home}/.config/rat-king/s3.json`,
                environment.endpoint,
                environment.bucket,
                "pointer",
              ],
              { redactions: environment.redactions }
            );

            if (result.code !== 0) {
              return yield* refuse(
                `Pointer existence read failed.\n${result.stderr ?? ""}`
              );
            }

            const pointer = yield* Schema.decodeEffect(
              Schema.fromJsonString(Pointer)
            )(result.stdout).pipe(
              Effect.mapError(() =>
                refuse("Malformed pointer existence response.")
              )
            );

            yield* Effect.log(
              "PRE_BOOTSTRAP_POINTER",
              JSON.stringify({ exists: pointer.status === 200 })
            );

            if (pointer.status === 404) {
              yield* bootstrapProbe(shell, { home }).pipe(
                Effect.provideContext(context),
                Effect.mapError(() =>
                  refuse("Bootstrap seed failed; both units must stop.")
                )
              );
            } else if (pointer.status !== 200) {
              return yield* refuse(
                "Pointer existence read returned an unexpected status."
              );
            }

            return yield* Effect.void;
          }).pipe(Effect.onError(() => stopBoth(shell).pipe(Effect.orDie)));
        },
      };
    })
  );
