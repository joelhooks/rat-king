import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Schema } from "effect";

import { absent } from "./absent.ts";
import { runtimeScript } from "./agent-runtime-script.ts";
import { AbsolutePath, deleteDirectory, refuse, textDigest } from "./files.ts";
import { HostShell, must } from "./host-shell.ts";
import { deleteDeclaredUnit } from "./systemd.ts";
import type { UnitProps } from "./systemd.ts";

export const RuntimeFilesSchema = Schema.Struct({
  agent: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u)),
  did: Schema.String.check(Schema.isPattern(/^did:web:/u)),
  gatewayUrl: Schema.String,
  home: AbsolutePath,
  mode: Schema.Literals(["faux", "gateway"]),
  ready: Schema.String,
  secretName: Schema.String,
  sidecar: Schema.Boolean,
  sidecarBundle: Schema.String,
});

export type RuntimeFilesProps = typeof RuntimeFilesSchema.Type;

export interface RuntimeFilesAttributes {
  readonly home: string;
  readonly bindings: string;
  readonly sha256: string;
  readonly sidecar: boolean;
  readonly mode: "faux" | "gateway";
}

export type RuntimeFilesResource = Resource<
  "RatsNest.AgentRuntimeFiles",
  RuntimeFilesProps,
  RuntimeFilesAttributes
>;

export const RuntimeFiles = Resource<RuntimeFilesResource>(
  "RatsNest.AgentRuntimeFiles"
);

export const validateRuntimeFiles = Effect.fn("AgentRuntimeFiles.validate")(
  function* validate(props: RuntimeFilesProps) {
    yield* Schema.decodeEffect(RuntimeFilesSchema)(props).pipe(
      Effect.mapError(() =>
        refuse("Invalid runtime declaration; private inputs redacted")
      )
    );

    if (props.mode === "faux") {
      if (
        props.sidecar ||
        props.gatewayUrl ||
        props.secretName ||
        props.sidecarBundle
      ) {
        return yield* refuse(
          "Faux mode forbids gateway and sidecar configuration"
        );
      }
    } else {
      const url = yield* Effect.try({
        catch: () => refuse("Invalid private gateway URL"),
        try: () => new URL(props.gatewayUrl),
      });

      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/v1\/?$/u.test(url.pathname) ||
        !/^[a-zA-Z0-9_.:-]+$/u.test(props.secretName) ||
        (props.sidecar && !props.sidecarBundle)
      ) {
        return yield* refuse("Invalid private runtime configuration");
      }
    }

    return props;
  }
);

export const sidecarUnit = (home: string, ready: string): UnitProps => ({
  home,
  name: "rat-king-claude-sidecar.service",
  restartOn: [ready],
  scope: "user",
  sections: [
    {
      lines: [["Description", "Rat King Claude model endpoint"]],
      name: "Unit",
    },
    {
      lines: [
        ["Type", "simple"],
        ["Slice", "rat-king.slice"],
        [
          "EnvironmentFile",
          `${home}/.local/share/rat-king/claude-sidecar/service.env`,
        ],
        [
          "ExecStart",
          `/usr/local/bin/node ${home}/.local/share/rat-king/claude-sidecar/sidecar.mjs`,
        ],
        ["MemoryMax", "1536M"],
        ["MemorySwapMax", "0"],
        ["CPUQuota", "100%"],
        ["Restart", "on-failure"],
        ["RestartSec", "5"],
        ["TimeoutStopSec", "10"],
        ["KillMode", "control-group"],
        ["NoNewPrivileges", "true"],
        ["UMask", "0077"],
      ],
      name: "Service",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});

const outputFor = (props: RuntimeFilesProps): RuntimeFilesAttributes => ({
  bindings: `${props.home}/.config/rat-king/agent-runtime/bindings`,
  home: props.home,
  mode: props.mode,
  sha256: textDigest(JSON.stringify(props)),
  sidecar: props.sidecar,
});

export const RuntimeFilesProvider = () =>
  Provider.effect(
    RuntimeFiles,
    Effect.gen(function* provider() {
      const shell = yield* HostShell;

      const observe = (props: RuntimeFilesProps) =>
        must(shell, [
          "python3",
          "-c",
          runtimeScript,
          "observe",
          JSON.stringify({
            ...props,
            sidecarBundle: "",
            sidecarSha256: textDigest(props.sidecarBundle),
          }),
        ]);

      const remove = Effect.fn("AgentRuntimeFiles.delete")(function* remove(
        output: RuntimeFilesAttributes
      ) {
        if (
          !shell.purgeRoots.includes(`${output.home}/.config/rat-king`) ||
          !shell.purgeRoots.includes(`${output.home}/.local/share/rat-king`)
        ) {
          return yield* refuse("Runtime delete escapes owned roots");
        }

        if (output.sidecar) {
          yield* deleteDeclaredUnit(shell, sidecarUnit(output.home, ""));
        }

        for (const path of [
          `${output.home}/.config/rat-king/agent-runtime`,
          ...(output.sidecar
            ? [
                `${output.home}/.local/share/rat-king/claude-sidecar`,
                `${output.home}/.local/share/rat-king/claude-code`,
              ]
            : []),
        ]) {
          const root = shell.purgeRoots.find((entry) =>
            path.startsWith(`${entry}/`)
          );

          if (root === undefined) {
            return yield* refuse("Missing runtime purge root");
          }

          yield* deleteDirectory(shell, {
            mode: 0o700,
            path,
            purgeRoot: root,
          });
        }

        return yield* Effect.void;
      });

      return RuntimeFiles.Provider.of({
        delete: ({ output }) => remove(output),
        diff: Effect.fn("AgentRuntimeFiles.diff")(function* diff({
          news,
          output,
        }) {
          if (!isResolved(news)) {
            return absent;
          }

          yield* validateRuntimeFiles(news);

          if (output !== undefined && output.home !== news.home) {
            return { action: "replace" };
          }

          return {
            action:
              output?.sha256 === outputFor(news).sha256 &&
              (yield* observe(news)).trim() === "ready"
                ? "noop"
                : "update",
          };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("AgentRuntimeFiles.read")(function* read({
          olds,
          output,
        }) {
          if (olds === undefined || output === undefined) {
            return absent;
          }

          yield* validateRuntimeFiles(olds);

          return output;
        }),
        reconcile: Effect.fn("AgentRuntimeFiles.reconcile")(
          function* reconcile({ news, output }) {
            yield* validateRuntimeFiles(news);

            if (
              output !== undefined &&
              (output.mode !== news.mode || output.sidecar !== news.sidecar)
            ) {
              return yield* refuse(
                "Runtime mode changes require destroy and fresh state"
              );
            }

            if (
              output === undefined &&
              (yield* shell.stat(
                `${news.home}/.config/rat-king/agent-runtime`
              )) !== undefined
            ) {
              return yield* refuse(
                "Existing runtime custody directory requires owned state"
              );
            }

            if (output === undefined && news.sidecar) {
              for (const name of ["claude-code", "claude-sidecar"]) {
                if (
                  (yield* shell.stat(
                    `${news.home}/.local/share/rat-king/${name}`
                  )) !== undefined
                ) {
                  return yield* refuse(
                    "Existing sidecar installation requires owned state"
                  );
                }
              }
            }

            return yield* Effect.gen(function* installRuntime() {
              yield* must(shell, [
                "python3",
                "-c",
                runtimeScript,
                "apply",
                JSON.stringify({ ...news, sidecarBundle: "" }),
              ]);

              if (news.sidecar) {
                yield* shell.write({
                  bytes: new TextEncoder().encode(news.sidecarBundle),
                  mode: 0o600,
                  path: `${news.home}/.local/share/rat-king/claude-sidecar/sidecar.mjs`,
                });
              }

              if ((yield* observe(news)).trim() !== "ready") {
                return yield* refuse("Runtime files failed readback");
              }

              return outputFor(news);
            }).pipe(
              Effect.onError(() =>
                output === undefined
                  ? remove(outputFor(news)).pipe(Effect.orDie)
                  : Effect.void
              )
            );
          }
        ),
      });
    })
  );
