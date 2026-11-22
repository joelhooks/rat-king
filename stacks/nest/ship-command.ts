import type { Path } from "effect";
import {
  Config,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  SecretStore,
  secretStoreLayer,
} from "../../apps/mailbox/cli/secrets.ts";
import { writePrivateJson } from "../../packages/ratking-client/src/directory.ts";
import { readShippedSha, shippedDrift } from "./runner-drift.ts";
import { RestartEvent, Sha, ShipCheckpoint } from "./ship-config.ts";
import type { ShipAttempt } from "./ship-config.ts";
import { sanitizeCandidateStderr } from "./ship-diagnostics.ts";
import { installDependencies, quarantineInstall } from "./ship-install.ts";
import { sendShipNotification } from "./ship-notify.ts";
import { deployOutcome } from "./ship-observation.ts";
import { prepareReleases, recordReceipt } from "./ship-prune.ts";
import type { ReleaseCurrent } from "./ship-prune.ts";
import { shipLoop } from "./ship.ts";
import type { ShipPorts } from "./ship.ts";
import { FleetError, causeDetail } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const Checks = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({
    check_runs: Schema.Array(
      Schema.Struct({
        app: Schema.String,
        conclusion: Schema.NullOr(Schema.String),
        html_url: Schema.String,
        id: Schema.Number,
        name: Schema.String,
        status: Schema.String,
      })
    ),
    sha: Sha,
  }),
});

const Workflow = Schema.Struct({
  conclusion: Schema.NullOr(Schema.String),
  event: Schema.String,
  head_branch: Schema.String,
  head_sha: Sha,
  path: Schema.String,
  status: Schema.String,
});

const executeRaw = Effect.fn("Ship.execute")(function* execute(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<{ RAT_KING_STAGE_CONFIG: string }>
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      cwd,
      env,
      extendEnv: true,
      forceKillAfter: "5 seconds",
      stdin: "ignore",
    })
  );

  let output = "";
  let outputTail = "";
  let stderr = "";

  const [code] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.runForEach(handle.stdout.pipe(Stream.decodeText()), (text) =>
        Effect.sync(() => {
          if (output.length < 1_048_576) {
            output += text.slice(0, 1_048_576 - output.length);
          }

          outputTail = (outputTail + text).slice(-65_536);
        })
      ),
      Stream.runForEach(handle.stderr.pipe(Stream.decodeText()), (text) =>
        Effect.sync(() => {
          stderr = (stderr + text).slice(-65_536);
        })
      ),
    ],
    { concurrency: "unbounded" }
  );

  return {
    code: Number(code),
    output,
    stderrTail:
      code === 0
        ? undefined
        : sanitizeCandidateStderr(`${outputTail}\n${stderr}`),
  };
}, Effect.scoped);

export const execute = (
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<{ RAT_KING_STAGE_CONFIG: string }>,
  step = "ship command"
) =>
  executeRaw(command, args, cwd, env).pipe(
    Effect.mapError(
      (cause) =>
        new FleetError({
          reason: `${step} process failed (${cause.reason._tag})`,
        })
    )
  );

export const runnerDrift = (checkpoint: string | undefined) =>
  shippedDrift(readShippedSha(checkpoint));

const requireSuccess = Effect.fn("Ship.requireSuccess")(
  function* requireSuccess(
    step: string,
    command: string,
    args: readonly string[],
    cwd: string
  ) {
    const result = yield* execute(command, args, cwd, undefined, step);

    if (result.code !== 0) {
      return yield* new FleetError({
        reason: `${step} failed (exit ${result.code}): ${result.stderrTail ?? "stderr unavailable"}`,
      });
    }

    return result.output;
  }
);

const checkoutCandidate = Effect.fn("Ship.checkoutCandidate")(
  function* checkoutCandidate(source: string, release: string, sha: string) {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(release))) {
      yield* requireSuccess(
        "candidate clone",
        "git",
        [
          "clone",
          "--local",
          "--no-hardlinks",
          "--no-checkout",
          "--",
          source,
          release,
        ],
        source
      );
      yield* requireSuccess(
        "candidate checkout",
        "git",
        ["checkout", "--detach", sha],
        release
      );
    }

    if ((yield* fs.lstat(release)).type !== "Directory") {
      return yield* new FleetError({
        reason: "Candidate release is not an owned directory",
      });
    }

    const current = (yield* requireSuccess(
      "candidate revision",
      "git",
      ["rev-parse", "HEAD"],
      release
    )).trim();

    const status = (yield* requireSuccess(
      "candidate status",
      "git",
      ["status", "--porcelain"],
      release
    )).trim();

    if (current !== sha || status !== "") {
      return yield* new FleetError({
        reason: "Candidate checkout does not match the fenced SHA",
      });
    }

    return yield* Effect.void;
  }
);

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const string = (text: string) => `<string>${escapeXml(text)}</string>`;

export const launchdPlist = (config: StageConfigValue, configPath: string) => {
  const { ship } = config;

  if (ship === undefined) {
    return "";
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key>${string(ship.launchd.label)}<key>ProgramArguments</key><array>${[ship.launchd.node, `${ship.source}/stacks/nest/cli.ts`, "ship"].map(string).join("")}</array><key>EnvironmentVariables</key><dict><key>RAT_KING_STAGE_CONFIG</key>${string(configPath)}<key>PATH</key>${string(ship.launchd.path)}</dict><key>WorkingDirectory</key>${string(ship.source)}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key>${string(ship.launchd.outputLog)}<key>StandardErrorPath</key>${string(ship.launchd.errorLog)}</dict></plist>\n`;
};

const recoveryNote = (recovered: boolean | undefined) => {
  if (recovered === undefined) {
    return "";
  }

  return recovered
    ? "; celld and seaweedfs were down after the failure and were started again"
    : "; RECOVERY FAILED: celld or seaweedfs is still down after the failed deploy, start them by hand";
};

export const shipCommand = Effect.fn("Ship.command")(
  function* shipCommand(
    config: StageConfigValue,
    recover: ShipPorts["recover"]
  ) {
    const { ship } = config;

    if (ship === undefined) {
      return yield* new FleetError({ reason: "Ship configuration required" });
    }

    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;
    const store = yield* SecretStore;
    yield* prepareReleases(ship.releases);
    const shipping = yield* Ref.make<ReleaseCurrent>({ attempt: "", sha: "" });
    const logged = yield* Ref.make<ReadonlySet<string>>(new Set());

    const saved = (yield* fs.exists(ship.checkpoint))
      ? yield* Schema.decodeEffect(Schema.fromJsonString(ShipCheckpoint))(
          yield* fs.readFileString(ship.checkpoint)
        ).pipe(
          Effect.mapError(
            (cause) =>
              new FleetError({
                reason: `Ship checkpoint invalid: ${causeDetail(cause)}`,
              })
          )
        )
      : { failed: "", successful: "" };

    const ports: ShipPorts<
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | HttpClient.HttpClient
    > = {
      checkpoint: (state) =>
        writePrivateJson(
          ship.checkpoint,
          JSON.stringify({
            deferred: state.deferred ?? "",
            failed: state.failed,
            failedGate: state.failedGate ?? "",
            retryAt: state.retryAt ?? 0,
            successful: state.successful,
          })
        ).pipe(
          Effect.mapError(
            (cause) =>
              new FleetError({
                reason: `Ship checkpoint write failed: ${causeDetail(cause)}`,
              })
          )
        ),
      ci: Effect.fn("Ship.fence")(
        function* fence(sha) {
          const checks = yield* Schema.decodeEffect(
            Schema.fromJsonString(Checks)
          )(
            yield* requireSuccess(
              "fence checks",
              ship.bot,
              ["checks", ship.repository, sha],
              ship.source
            )
          );

          if (checks.result.sha !== sha) {
            return false;
          }

          const [latest] = checks.result.check_runs
            .filter(
              (check) =>
                check.name === "fence" && check.app === "github-actions"
            )
            .toSorted((a, b) => b.id - a.id);

          if (
            latest === undefined ||
            latest.status !== "completed" ||
            latest.conclusion !== "success"
          ) {
            return false;
          }

          const runId = /\/actions\/runs\/(?<run>\d+)\//u.exec(latest.html_url)
            ?.groups?.run;

          if (runId === undefined) {
            return false;
          }

          const response = yield* http.get(
            `https://api.github.com/repos/${ship.repository}/actions/runs/${runId}`,
            { headers: { "User-Agent": "rat-king" } }
          );

          if (response.status !== 200) {
            return false;
          }

          const workflow = yield* Schema.decodeUnknownEffect(Workflow)(
            yield* response.json
          );

          return (
            workflow.head_sha === sha &&
            workflow.head_branch === "main" &&
            workflow.event === "push" &&
            workflow.path === ".github/workflows/fence.yml" &&
            workflow.status === "completed" &&
            workflow.conclusion === "success"
          );
        },
        (effect) =>
          effect.pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              (cause) =>
                new FleetError({
                  reason: `Fence workflow evidence unavailable: ${causeDetail(cause)}`,
                })
            )
          )
      ),
      deploy: Effect.fn("Ship.deploy")(
        function* deploy(sha) {
          const release = `${ship.releases}/${sha}`;
          yield* Ref.set(shipping, { attempt: "", sha });

          const checkout = checkoutCandidate(ship.source, release, sha);
          yield* checkout;
          yield* installDependencies({
            pnpm: ship.launchd.pnpm,
            release,
            reset: quarantineInstall(ship.releases, sha).pipe(
              Effect.andThen(checkout),
              Effect.mapError((error) =>
                Schema.is(FleetError)(error)
                  ? error
                  : new FleetError({
                      reason: `Release reset failed (${error.reason._tag})`,
                    })
              )
            ),
          });

          const attemptDirectory = yield* fs.makeTempDirectory({
            directory: ship.releases,
            prefix: "attempt-",
          });

          yield* Ref.set(shipping, {
            attempt: attemptDirectory.slice(
              attemptDirectory.lastIndexOf("/") + 1
            ),
            sha,
          });

          const override = yield* Config.option(
            Config.schema(
              Schema.NonEmptyString,
              "RAT_KING_SHIP_RESTART_OVERRIDE"
            )
          );

          const events = `${attemptDirectory}/restart-events.jsonl`;

          const shipAttempt: typeof ShipAttempt.Type = Option.isSome(override)
            ? { events, override: override.value, restart: ship.restart, sha }
            : { events, restart: ship.restart, sha };

          const configPath = `${attemptDirectory}/stage.json`;
          yield* fs.writeFileString(events, "", { flag: "wx", mode: 0o600 });
          yield* writePrivateJson(
            configPath,
            JSON.stringify({
              ...config,
              runtime: { ...config.runtime, RAT_KING_COMMIT: sha },
              shipAttempt,
            })
          );

          const result = yield* execute(
            ship.launchd.node,
            ["stacks/nest/cli.ts", "deploy"],
            release,
            { RAT_KING_STAGE_CONFIG: configPath },
            "candidate deploy"
          );

          const observations = yield* Effect.forEach(
            (yield* fs.readFileString(events))
              .split("\n")
              .filter((line) => line !== ""),
            (line) =>
              Schema.decodeEffect(Schema.fromJsonString(RestartEvent))(line)
          );

          const verdict = deployOutcome(result.code, observations);

          const diagnostic =
            result.stderrTail === undefined
              ? verdict
              : {
                  ...verdict,
                  stderrTail:
                    `candidate deploy exited ${result.code}: ${result.stderrTail}`.slice(
                      0,
                      2048
                    ),
                };

          return diagnostic;
        },
        (effect) =>
          effect.pipe(
            Effect.timeout("20 minutes"),
            Effect.mapError((cause) =>
              Schema.is(FleetError)(cause)
                ? cause
                : new FleetError({
                    reason: `Candidate deploy failed; restart outcome unknown: ${Predicate.isTagged(cause, "TimeoutError") ? "timed out after 20 min" : causeDetail(cause)}`,
                  })
            )
          )
      ),
      fetch: Effect.gen(function* fetch() {
        yield* requireSuccess(
          "main fetch",
          "git",
          ["fetch", "origin", "main"],
          ship.source
        );

        return yield* Schema.decodeEffect(Sha)(
          (yield* requireSuccess(
            "main revision",
            "git",
            ["rev-parse", "origin/main"],
            ship.source
          )).trim()
        );
      }).pipe(
        Effect.timeout("60 seconds"),
        Effect.mapError(
          (cause) =>
            new FleetError({
              reason: `Main fetch failed: ${causeDetail(cause)}`,
            })
        )
      ),
      notify: (receipt) =>
        sendShipNotification(
          config,
          `ship ${receipt.sha.slice(0, 12)} ${receipt.result}; celld restart=${receipt.celldRestarted ?? "unknown"}; restart ${receipt.restartSeconds === null ? "unknown" : receipt.restartSeconds.toFixed(3)}s${recoveryNote(receipt.recovered)} SR 🐀`,
          receipt.result === "deferred" ||
            (receipt.result === "success" && receipt.celldRestarted !== true)
        ).pipe(Effect.provideService(SecretStore, store)),
      record: recordReceipt(ship, shipping, logged),
      recover,
    };

    return yield* shipLoop(
      ports,
      saved,
      ship.intervalSeconds,
      yield* runnerDrift(ship.checkpoint)
    );
  },
  (effect) =>
    effect.pipe(
      Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]),
      Effect.mapError((cause) =>
        Schema.is(FleetError)(cause)
          ? cause
          : new FleetError({
              reason: `Ship stopped; check checkpoint and receipts before restarting: ${causeDetail(cause)}`,
            })
      )
    )
);
