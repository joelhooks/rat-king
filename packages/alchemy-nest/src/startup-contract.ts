import type { Crypto, FileSystem } from "effect";
import { Effect, Layer, Predicate, Result, Schema } from "effect";

import { refuse } from "./files.ts";
import { HostShell } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { assessListeners, readListeners } from "./listeners.ts";
import { bootstrapProbe, probeEnvironment } from "./probes.ts";
import type { ProbeRunnerMode } from "./probes.ts";
import { s3Script } from "./s3-script.ts";
import { UnitStartup } from "./unit-startup.ts";

export { assessListeners } from "./listeners.ts";

export const stopUnit = Effect.fn("UnitStartup.stopUnit")(function* stopUnit(
  shell: Interface,
  name: string
) {
  const stopped = yield* shell.exec(["systemctl", "--user", "stop", name]);

  if (stopped.code === 0) {
    return yield* Effect.void;
  }

  const load = yield* shell.exec([
    "systemctl",
    "--user",
    "show",
    name,
    "--property=LoadState",
  ]);

  if (load.code === 0 && load.stdout.trim() === "LoadState=not-found") {
    return yield* Effect.void;
  }

  return yield* refuse("User unit stop failed; unit absence was not proven.");
});

export const stopUnits = Effect.fn("UnitStartup.stopUnits")(function* stopUnits(
  shell: Interface,
  names: readonly string[]
) {
  const results = yield* Effect.all(
    names.map((name) => stopUnit(shell, name).pipe(Effect.result))
  );

  const failure = results.find(Result.isFailure);

  if (failure !== undefined) {
    return yield* failure.failure;
  }

  return yield* Effect.void;
});

const stopBoth = Effect.fn("UnitStartup.stopBoth")(function* stop(
  shell: Interface
) {
  yield* stopUnits(shell, [
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
    yield* stopUnit(shell, "rat-king-claude-sidecar.service");
  }
});

const assertStarted = Effect.fn("UnitStartup.assertStarted")(function* check(
  shell: Interface,
  publicIPv4: string,
  nodeExpected: boolean,
  sidecarExpected: boolean,
  attempts = 40
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const listeners = yield* readListeners(shell);

    const assessment = assessListeners(
      listeners.text,
      publicIPv4,
      nodeExpected,
      sidecarExpected,
      listeners.unitCgroups
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

export const startupLayer = (
  publicIPv4: string,
  runnerMode: ProbeRunnerMode = "scope"
) =>
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

            const readiness = assertStarted(
              shell,
              publicIPv4,
              name !== "rat-king-seaweedfs.service" || nodeActive,
              name === "rat-king-claude-sidecar.service" || sidecarActive,
              name === "rat-king-seaweedfs.service" ? 120 : 40
            );

            yield* name === "rat-king-seaweedfs.service"
              ? readiness.pipe(
                  Effect.timeoutOrElse({
                    duration: "30 seconds",
                    orElse: () => refuse("Weed readiness deadline exceeded."),
                  })
                )
              : readiness;
          }).pipe(
            Effect.onError(() =>
              stopBoth(shell).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    Effect.logError("STARTUP_CLEANUP_FAILED", error),
                  onSuccess: () => Effect.void,
                })
              )
            )
          );
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
              yield* bootstrapProbe(shell, { home, runnerMode }).pipe(
                Effect.provideContext(context),
                Effect.mapError((error) =>
                  Predicate.isTagged(error, "HostError")
                    ? error
                    : refuse("Bootstrap operation failed before publication.")
                )
              );
            } else if (pointer.status !== 200) {
              return yield* refuse(
                "Pointer existence read returned an unexpected status."
              );
            }

            return yield* Effect.void;
          }).pipe(
            Effect.onError(() =>
              stopBoth(shell).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    Effect.logError("STARTUP_CLEANUP_FAILED", error),
                  onSuccess: () => Effect.void,
                })
              )
            )
          );
        },
      };
    })
  );
