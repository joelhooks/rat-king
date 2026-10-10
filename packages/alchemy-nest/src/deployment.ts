import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Result, Schedule, Schema } from "effect";
import { HttpClient } from "effect/http";

import { absent } from "./absent.ts";
import { ownedPath } from "./adoption.ts";
import {
  DeploymentError,
  GeneratedConfiguration,
} from "./deployment-config.ts";
import { AbsolutePath, deleteDirectory, digest, textDigest } from "./files.ts";
import { HostShell, must } from "./host-shell.ts";
import { shellQuote } from "./ssh.ts";

export interface DeploymentProps {
  readonly bundle: string;
  readonly configuration: string;
  readonly version: string;
  readonly commit: string;
  readonly directory: string;
  readonly binary: string;
  readonly environmentFile: string;
  readonly internalUrl: string;
  readonly workerUrl: string;
  readonly bindingsFile?: string;
}

export interface DeploymentAttributes extends DeploymentProps {
  readonly sha256: string;
}

export type DeploymentResource = Resource<
  "Celld.Deployment",
  DeploymentProps,
  DeploymentAttributes
>;

export const Deployment = Resource<DeploymentResource>("Celld.Deployment");

export const bindingConfigurationScript = String.raw`
import json, pathlib, stat, sys
try:
    directory, binding = map(pathlib.Path, sys.argv[1:3])
    for path in [directory, binding, directory/"wrangler.public.json", directory/"wrangler.json"]:
        if any(part.is_symlink() for part in [path, *path.parents]):
            raise ValueError()
    if stat.S_IMODE(binding.stat().st_mode) != 0o600:
        raise ValueError()
    config = json.loads((directory/"wrangler.public.json").read_text())
    secrets = json.loads(binding.read_text())
    allowed = {"AGENT_IDENTITIES_CREDENTIAL", "MODEL_GATEWAY_CREDENTIAL", "CLAUDE_SIDECAR_CREDENTIAL"}
    if not secrets or not set(secrets).issubset(allowed) or set(secrets).intersection(config["vars"]):
        raise ValueError()
    config["vars"].update(secrets)
    target = directory/"wrangler.json"
    target.touch(mode=0o600, exist_ok=True)
    target.chmod(0o600)
    target.write_text(json.dumps(config))
except Exception:
    print("Private binding generation refused", file=sys.stderr)
    sys.exit(1)
`;

const identity = Schema.Struct({
  commit: Schema.String,
  version: Schema.String,
});

const fingerprint = (props: DeploymentProps) =>
  textDigest(
    JSON.stringify([
      props.bundle,
      props.configuration,
      props.version,
      props.commit,
      props.directory,
      props.binary,
      props.environmentFile,
      props.internalUrl,
      props.workerUrl,
      props.bindingsFile,
    ])
  );

const validate = Effect.fn("Celld.Deployment.validate")(function* validate(
  props: DeploymentProps
) {
  yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(GeneratedConfiguration),
    { onExcessProperty: "error" }
  )(props.configuration).pipe(
    Effect.mapError(
      () =>
        new DeploymentError({
          reason: "Invalid generated deployment configuration",
        })
    )
  );

  for (const path of [props.directory, props.binary, props.environmentFile]) {
    yield* Schema.decodeEffect(AbsolutePath)(path);
  }

  if (props.bindingsFile !== undefined) {
    yield* Schema.decodeEffect(AbsolutePath)(props.bindingsFile);
  }

  const internal = yield* Effect.try({
    catch: () =>
      new DeploymentError({ reason: "Invalid internal listener URL" }),
    try: () => new URL(props.internalUrl),
  });

  if (
    internal.protocol !== "http:" ||
    internal.hostname !== "127.0.0.1" ||
    internal.pathname !== "/"
  ) {
    return yield* new DeploymentError({
      reason: "Reload must use the loopback operator listener",
    });
  }

  return yield* Effect.void;
});

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* makeDeploymentProvider() {
      const shell = yield* HostShell;
      const http = yield* HttpClient.HttpClient;

      const version = Effect.fn("Celld.Deployment.version")(function* version(
        props: DeploymentProps
      ) {
        const response = yield* http.get(
          new URL("/.well-known/rat-king/version", props.workerUrl).href
        );

        if (response.status !== 200) {
          return yield* new DeploymentError({
            reason: "Version readback failed",
          });
        }

        const current = yield* Schema.decodeUnknownEffect(identity)(
          yield* response.json
        );

        if (
          current.version !== props.version ||
          current.commit !== props.commit
        ) {
          return yield* new DeploymentError({
            reason: "Bundle identity does not match",
          });
        }

        return yield* Effect.void;
      });

      const installed = Effect.fn("Celld.Deployment.installed")(
        function* installed(props: DeploymentProps) {
          const bundleMode = yield* shell.stat(`${props.directory}/worker.mjs`);

          const configurationMode = yield* shell.stat(
            `${props.directory}/${props.bindingsFile === undefined ? "wrangler.json" : "wrangler.public.json"}`
          );

          const bundle = yield* shell.read(`${props.directory}/worker.mjs`);

          const configuration = yield* shell.read(
            `${props.directory}/${props.bindingsFile === undefined ? "wrangler.json" : "wrangler.public.json"}`
          );

          return (
            bundleMode?.mode === 0o600 &&
            configurationMode?.mode === 0o600 &&
            bundle !== undefined &&
            configuration !== undefined &&
            digest(bundle) === textDigest(props.bundle) &&
            digest(configuration) === textDigest(props.configuration)
          );
        }
      );

      return Deployment.Provider.of({
        delete: Effect.fn("Celld.Deployment.delete")(function* remove({
          output,
        }) {
          const root = shell.purgeRoots.find((path) =>
            path.endsWith("/.config/rat-king")
          );

          if (
            root === undefined ||
            output.directory !== `${root}/mailbox-deployment`
          ) {
            return yield* new DeploymentError({
              reason: "Deployment delete escapes owned configuration",
            });
          }

          return yield* deleteDirectory(shell, {
            mode: 0o700,
            path: output.directory,
            purgeRoot: root,
          });
        }),
        diff: Effect.fn("Celld.Deployment.diff")(function* diff({
          news,
          output,
        }) {
          if (!isResolved(news)) {
            return absent;
          }

          yield* validate(news);

          if (output !== undefined && output.directory !== news.directory) {
            return { action: "replace" };
          }

          if (
            output === undefined ||
            output.sha256 !== fingerprint(news) ||
            !(yield* installed(news))
          ) {
            return { action: "update" };
          }

          const observed = yield* version(news).pipe(Effect.result);

          return { action: Result.isSuccess(observed) ? "noop" : "update" };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("Celld.Deployment.read")(function* read({
          olds,
          output,
        }) {
          if (olds === undefined) {
            return absent;
          }

          yield* validate(olds);

          if (!(yield* installed(olds))) {
            if (
              output === undefined &&
              (yield* shell.stat(olds.directory)) !== undefined
            ) {
              return yield* new DeploymentError({
                reason: "Only the exact declared deployment may be adopted",
              });
            }

            return absent;
          }

          if (output !== undefined) {
            return output;
          }

          const attrs = { ...olds, sha256: fingerprint(olds) };

          if (!(yield* ownedPath(shell, olds.directory))) {
            return Unowned(attrs);
          }

          const directory = yield* shell.stat(olds.directory);
          const bundle = yield* shell.stat(`${olds.directory}/worker.mjs`);

          const config = yield* shell.stat(
            `${olds.directory}/${olds.bindingsFile === undefined ? "wrangler.json" : "wrangler.public.json"}`
          );

          if (
            directory?.mode !== 0o700 ||
            bundle?.mode !== 0o600 ||
            config?.mode !== 0o600
          ) {
            return yield* new DeploymentError({
              reason: "Deployment adoption requires private file modes",
            });
          }

          yield* version(olds);

          return attrs;
        }),
        reconcile: Effect.fn("Celld.Deployment.reconcile")(function* reconcile({
          news,
          output,
        }) {
          yield* validate(news);
          const directory = yield* shell.stat(news.directory);

          if (
            output?.sha256 === fingerprint(news) &&
            (yield* installed(news))
          ) {
            yield* version(news);

            return output;
          }

          if (
            output === undefined &&
            directory !== undefined &&
            !(yield* installed(news))
          ) {
            return yield* new DeploymentError({
              reason:
                "Existing deployment directory requires explicit adoption",
            });
          }

          if (directory === undefined) {
            yield* shell.mkdir({ mode: 0o700, path: news.directory });
          } else if (
            directory.kind !== "directory" ||
            directory.mode !== 0o700
          ) {
            return yield* new DeploymentError({
              reason: "Deployment directory must have mode 700",
            });
          }

          if (!(yield* installed(news))) {
            yield* shell.write({
              bytes: new TextEncoder().encode(news.bundle),
              mode: 0o600,
              path: `${news.directory}/worker.mjs`,
            });
            yield* shell.write({
              bytes: new TextEncoder().encode(news.configuration),
              mode: 0o600,
              path: `${news.directory}/${news.bindingsFile === undefined ? "wrangler.json" : "wrangler.public.json"}`,
            });
          }

          if (news.bindingsFile !== undefined) {
            yield* must(shell, [
              "python3",
              "-c",
              bindingConfigurationScript,
              news.directory,
              news.bindingsFile,
            ]);
          }

          yield* must(shell, [
            "sh",
            "-c",
            `set -a; . ${shellQuote(news.environmentFile)}; set +a; exec ${shellQuote(news.binary)} deploy ${shellQuote(news.directory)} --json`,
          ]);
          yield* must(shell, [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "30",
            "-X",
            "POST",
            new URL("/reload", news.internalUrl).href,
          ]);
          yield* version(news).pipe(
            Effect.retry(Schedule.spaced("1 second")),
            Effect.timeout("60 seconds")
          );

          return { ...news, sha256: fingerprint(news) };
        }),
      });
    })
  );
