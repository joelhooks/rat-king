import type { Crypto, FileSystem } from "effect";
import { Data, Effect, Layer, Predicate, Schema } from "effect";

import { refuse } from "./files.ts";
import { HostShell, must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { bootstrapProbe, probeEnvironment } from "./probes.ts";
import { s3Script } from "./s3-script.ts";
import { UnitStartup } from "./unit-startup.ts";

const storePorts = [
  19_333, 18_081, 18_888, 18_333, 29_333, 28_081, 28_888, 28_333,
];

export type ListenerAssessment =
  | { readonly _tag: "Ready"; readonly receipt: string }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Violation"; readonly receipt: string };

const Assessment = Data.taggedEnum<ListenerAssessment>();

export const assessListeners = (
  text: string,
  publicIPv4: string,
  nodeExpected: boolean
): ListenerAssessment => {
  const lines = text
    .split("\n")
    .filter((line) =>
      nodeExpected
        ? /users:\(\("(?:weed|celld)"/u.test(line)
        : /users:\(\("weed"/u.test(line)
    );

  const expected = new Map(storePorts.map((port) => [port, "weed"]));

  if (nodeExpected) {
    expected.set(18_787, "celld");
    expected.set(18_788, "celld");
  }

  for (const line of lines) {
    const local = line.trim().split(/\s+/u)[3] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));

    const process = /users:\(\("(?<process>weed|celld)"/u.exec(line)?.groups
      ?.process;

    if (
      expected.get(port) !== process ||
      local !== `${port === 18_787 ? publicIPv4 : "127.0.0.1"}:${port}` ||
      !expected.delete(port)
    ) {
      return Assessment.Violation({ receipt: lines.join("\n") });
    }
  }

  return expected.size === 0
    ? Assessment.Ready({ receipt: lines.join("\n") })
    : Assessment.Waiting();
};

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
});

const assertStarted = Effect.fn("UnitStartup.assertStarted")(function* check(
  shell: Interface,
  publicIPv4: string,
  nodeExpected: boolean
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const assessment = assessListeners(
      yield* must(shell, ["ss", "-ltnp"]),
      publicIPv4,
      nodeExpected
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
            name !== "rat-king-celld.service"
          ) {
            return Effect.void;
          }

          return assertStarted(
            shell,
            publicIPv4,
            name === "rat-king-celld.service"
          ).pipe(Effect.onError(() => stopBoth(shell).pipe(Effect.orDie)));
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
