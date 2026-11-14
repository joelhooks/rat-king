import type { FileSystem, Redacted } from "effect";
import { Effect, Layer, Predicate, Result, Schema } from "effect";
import type * as SecureRandom from "effect/crypto/SecureRandom";

import { assertDeletePath } from "./delete-custody.ts";
import { refuse } from "./files.ts";
import { HostShell } from "./host-shell.ts";
import type { HostError, Interface } from "./host-shell.ts";
import {
  assessListeners,
  ListenerExposure,
  readListeners,
} from "./instance-listeners.ts";
import { bootstrapProbe, probeEnvironment } from "./instance-probes.ts";
import type { ProbeRunnerMode } from "./instance-probes.ts";
import type { InstanceLayout } from "./instance.ts";
import { s3Script } from "./s3-script.ts";
import { UnitStartup } from "./unit-startup.ts";

export { assessListeners } from "./instance-listeners.ts";

export const stopUnit = Effect.fn("UnitStartup.stopUnit")(function* stopUnit(
  shell: Pick<Interface, "exec">,
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
  shell: Pick<Interface, "exec">,
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
  shell: Interface,
  layout?: InstanceLayout
) {
  yield* stopUnits(shell, [
    layout?.nodeUnit ?? "rat-king-celld.service",
    layout?.storeUnit ?? "rat-king-seaweedfs.service",
  ]);

  if (
    layout === undefined &&
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

const UNIT_UP = new Set(["active", "activating", "reloading"]);

export const assertStarted = Effect.fn("UnitStartup.assertStarted")(
  function* check(
    shell: Pick<Interface, "exec">,
    publicIPv4: string,
    nodeExpected: boolean,
    sidecarExpected: boolean,
    attempts = 40,
    layout?: InstanceLayout
  ) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const listeners = yield* readListeners(shell, layout);

      const assessment = assessListeners(
        listeners.text,
        publicIPv4,
        nodeExpected,
        sidecarExpected,
        listeners.unitCgroups,
        layout
      );

      if (Predicate.isTagged(assessment, "Ready")) {
        yield* Effect.log("STARTUP_LISTENERS_PASSED", assessment.receipt);

        return yield* Effect.void;
      }

      if (Predicate.isTagged(assessment, "Violation")) {
        return yield* new ListenerExposure({ receipt: assessment.receipt });
      }

      if (Predicate.isTagged(assessment, "Early")) {
        return yield* refuse(
          `Declared listener appeared before its unit was expected; units left running.\n${assessment.receipt}`
        );
      }

      yield* Effect.sleep("250 millis");
    }

    return yield* refuse(
      "Startup listener deadline exceeded; units left running."
    );
  }
);

const importRestoredObjects = Effect.fn("UnitStartup.importRestoredObjects")(
  function* importRestoredObjects(
    shell: Interface,
    home: string,
    archive: string | undefined,
    redactions: readonly Redacted.Redacted[],
    layout?: InstanceLayout
  ) {
    if (archive === undefined) {
      return yield* Effect.void;
    }

    if (
      shell.deleteCustody !== undefined &&
      archive !==
        `${shell.deleteCustody.layout.dataRoot}/.mailbox-restore-objects.tar`
    ) {
      return yield* refuse("Restore archive escapes its instance data root.");
    }

    yield* assertDeletePath(shell, archive, "files");

    const file = yield* shell.stat(archive);

    if (file === undefined) {
      return yield* Effect.void;
    }

    if (file.kind !== "file" || file.mode !== 0o600) {
      return yield* refuse("Restore object archive has unsafe custody");
    }

    const state = yield* shell.exec([
      "systemctl",
      "--user",
      "show",
      layout?.nodeUnit ?? "rat-king-celld.service",
      "--property=ActiveState",
      "--value",
    ]);

    if (
      state.code !== 0 ||
      !["inactive", "failed"].includes(state.stdout.trim())
    ) {
      return yield* refuse("Object restore requires celld stopped");
    }

    const imported = yield* shell.exec(
      [
        "python3",
        "-c",
        s3Script,
        `${layout?.configuration ?? `${home}/.config/rat-king`}/s3.json`,
        `http://127.0.0.1:${layout?.ports.s3 ?? 18_333}`,
        "@environment",
        "import",
        archive,
      ],
      { redactions }
    );

    if (imported.code !== 0) {
      return yield* refuse(
        `Object import failed before celld startup.\n${imported.stderr ?? ""}`
      );
    }

    yield* shell.remove(archive);
    yield* Effect.log("RESTORED_OBJECTS_IMPORTED", imported.stdout.trim());

    return yield* Effect.void;
  }
);

const Pointer = Schema.Struct({
  status: Schema.Int,
  version: Schema.String,
});

export const startupLayer = (
  publicIPv4: string,
  runnerMode: ProbeRunnerMode = "scope",
  restoreArchive?: string,
  restoreData?: Effect.Effect<void, HostError>,
  layout?: InstanceLayout
) =>
  Layer.effect(
    UnitStartup,
    Effect.gen(function* startup() {
      const shell = yield* HostShell;

      const context = yield* Effect.context<
        SecureRandom.SecureRandom | FileSystem.FileSystem
      >();

      return {
        afterStart: (name: string) => {
          if (
            name !== (layout?.storeUnit ?? "rat-king-seaweedfs.service") &&
            name !== (layout?.nodeUnit ?? "rat-king-celld.service") &&
            (layout !== undefined || name !== "rat-king-claude-sidecar.service")
          ) {
            return Effect.void;
          }

          return Effect.gen(function* checkStarted() {
            const active = (unit: string) =>
              shell.exec(["systemctl", "--user", "is-active", unit]);

            const nodeActive = UNIT_UP.has(
              (yield* active(
                layout?.nodeUnit ?? "rat-king-celld.service"
              )).stdout.trim()
            );

            const sidecarActive =
              layout === undefined &&
              UNIT_UP.has(
                (yield* active("rat-king-claude-sidecar.service")).stdout.trim()
              );

            const readiness = assertStarted(
              shell,
              publicIPv4,
              name !== (layout?.storeUnit ?? "rat-king-seaweedfs.service") ||
                nodeActive,
              name === "rat-king-claude-sidecar.service" || sidecarActive,
              name === (layout?.storeUnit ?? "rat-king-seaweedfs.service")
                ? 120
                : 40,
              layout
            );

            yield* name === (layout?.storeUnit ?? "rat-king-seaweedfs.service")
              ? readiness.pipe(
                  Effect.timeoutOrElse({
                    duration: "30 seconds",
                    orElse: () => refuse("Weed readiness deadline exceeded."),
                  })
                )
              : readiness;
          }).pipe(
            Effect.catchTag("ListenerExposure", ({ receipt }) =>
              stopBoth(shell, layout).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    Effect.logError("STARTUP_CLEANUP_FAILED", error),
                  onSuccess: () => Effect.void,
                }),
                Effect.andThen(
                  Effect.fail(
                    refuse(
                      `Startup listener contract violated; both units stopped.\n${receipt}`
                    )
                  )
                )
              )
            )
          );
        },
        beforeStart: (name: string, home: string) => {
          if (name !== (layout?.nodeUnit ?? "rat-king-celld.service")) {
            return Effect.void;
          }

          return Effect.gen(function* seed() {
            yield* restoreData ?? Effect.void;

            const environment = yield* probeEnvironment(shell, home, layout);

            yield* importRestoredObjects(
              shell,
              home,
              restoreArchive,
              environment.redactions,
              layout
            );

            const result = yield* shell.exec(
              [
                "python3",
                "-c",
                s3Script,
                `${layout?.configuration ?? `${home}/.config/rat-king`}/s3.json`,
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
              yield* bootstrapProbe(shell, {
                home,
                layout,
                runnerMode,
              }).pipe(
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
              stopBoth(shell, layout).pipe(
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
