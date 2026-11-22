import type { Path } from "effect";
import {
  Console,
  Effect,
  FileSystem,
  Option,
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
import { digest } from "../../packages/alchemy-nest/src/files.ts";
import { writePrivateJson } from "../../packages/ratking-client/src/directory.ts";
import { encodePrepared } from "./prepared-payload.ts";
import { readShippedSha, runtimeDrift, shippedDrift } from "./runner-drift.ts";
import { boundDeploy, observeAttempt, startAttempt } from "./ship-attempt.ts";
import { Sha, ShipCheckpoint } from "./ship-config.ts";
import { sanitizeCandidateStderr } from "./ship-diagnostics.ts";
import { installDependencies, quarantineInstall } from "./ship-install.ts";
import { sendShipNotification } from "./ship-notify.ts";
import {
  preparedEvidence,
  verifyShipWorkspace,
} from "./ship-prepared-evidence.ts";
import type { PreparedArgs } from "./ship-prepared-evidence.ts";
import { prepareReleases, recordReceipt } from "./ship-prune.ts";
import type { ReleaseCurrent } from "./ship-prune.ts";
import { preparedBackoff, selectPrepared } from "./ship-select.ts";
import { shipLoop } from "./ship.ts";
import type { PreparedShipPorts, ShipPorts } from "./ship.ts";
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
    recover: ShipPorts["recover"],
    prepared?: PreparedArgs
  ) {
    const { ship } = config;

    if (ship === undefined) {
      return yield* new FleetError({ reason: "Ship configuration required" });
    }

    if (prepared !== undefined && config.runtime.RAT_KING_STAGE !== "fleet") {
      return yield* new FleetError({
        reason: "Prepared ship requires the fleet stage",
      });
    }

    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;
    const store = yield* SecretStore;

    if (prepared !== undefined) {
      yield* verifyShipWorkspace(ship.releases);
    }

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

    const holds = yield* Ref.make<Readonly<Record<string, string>>>(
      saved.preparedHolds ?? {}
    );

    type Services =
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | HttpClient.HttpClient;

    const shared: Omit<ShipPorts<Services>, "fetch" | "ci" | "deploy"> = {
      checkpoint: (state) =>
        Ref.get(holds).pipe(
          Effect.flatMap((preparedHolds) =>
            writePrivateJson(
              ship.checkpoint,
              JSON.stringify({
                deferred: state.deferred ?? "",
                failed: state.failed,
                failedGate: state.failedGate ?? "",
                preparedHolds:
                  Object.keys(preparedHolds).length === 0
                    ? undefined
                    : preparedHolds,
                preparedRetries:
                  Object.keys(state.preparedRetries ?? {}).length === 0
                    ? undefined
                    : state.preparedRetries,
                retryAt: state.retryAt ?? 0,
                successful: state.successful,
              })
            )
          ),
          Effect.mapError(
            (cause) =>
              new FleetError({
                reason: `Ship checkpoint write failed: ${causeDetail(cause)}`,
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

    if (prepared !== undefined) {
      const { drifted } = yield* runtimeDrift;

      const evidence = preparedEvidence(
        ship.repository,
        prepared,
        ship.releases
      );

      const backoff = preparedBackoff();

      const ports: PreparedShipPorts<Services> = {
        ...shared,
        deployPrepared: Effect.fn("Ship.applyPrepared")(function* applyPrepared(
          payload
        ) {
          const attempt = yield* startAttempt(
            ship,
            config,
            payload.commit,
            payload.version,
            shipping
          );

          const configPath = `${attempt.directory}/stage.json`;
          const artifact = `${attempt.directory}/verified.bundle`;
          const bytes = encodePrepared(payload);
          yield* writePrivateJson(configPath, JSON.stringify(attempt.config));
          yield* fs.writeFile(artifact, bytes, { flag: "wx", mode: 0o600 });

          const result = yield* execute(
            process.execPath,
            [
              `${import.meta.dirname}/prepared-apply.ts`,
              artifact,
              payload.commit,
              digest(bytes),
            ],
            config.runtime.RAT_KING_STATE_DIR,
            { RAT_KING_STAGE_CONFIG: configPath },
            "trusted prepared apply"
          );

          return yield* observeAttempt(attempt.events, result);
        }, boundDeploy),
        select: (state, now) =>
          Effect.gen(function* selectAndRecord() {
            if (yield* drifted) {
              return Option.none();
            }

            const observed = new Map<string, string>();

            const selection = yield* selectPrepared<Services>(
              evidence,
              state,
              now,
              (sha, reason) => {
                if (observed.size < 256) {
                  observed.set(sha || "global", reason);
                }
              },
              backoff
            );

            const previous = yield* Ref.get(holds);

            const changed = [...observed].filter(
              ([sha, reason]) => previous[sha] !== reason
            );

            if (
              changed.length === 0 &&
              observed.size === Object.keys(previous).length
            ) {
              return selection;
            }

            yield* Ref.set(holds, Object.fromEntries(observed));
            yield* shared.checkpoint(state);

            const reasons = changed.map(
              ([sha, reason]) => `${sha.slice(0, 12)}: ${reason}`
            );

            for (const [key, reason] of changed) {
              yield* Console.error("SHIP_PREPARED_HOLD", key, reason);
              const sha = key === "global" ? state.successful : key;

              if (sha !== "") {
                yield* shared.record({
                  celldRestarted: null,
                  end: now,
                  hold: reason,
                  restartSeconds: null,
                  result: "held",
                  sha,
                  start: now,
                });
              }
            }

            if (reasons.length > 0) {
              yield* sendShipNotification(
                config,
                `Prepared ship hold: ${reasons.slice(0, 8).join("; ").slice(0, 1500)} SR 🐀`,
                false
              ).pipe(
                Effect.provideService(SecretStore, store),
                Effect.catch(() =>
                  Console.error("SHIP_PREPARED_HOLD_NOTIFICATION_FAILED")
                )
              );
            }

            return selection;
          }).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.logError("SHIP_HOLD_WRITE_FAILED", error.reason).pipe(
                  Effect.as(Option.none())
                ),
              onSuccess: Effect.succeed,
            })
          ),
      };

      return yield* shipLoop(
        ports,
        saved,
        Math.max(120, ship.intervalSeconds),
        drifted
      );
    }

    const ports: ShipPorts<Services> = {
      ...shared,
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
      deploy: Effect.fn("Ship.deploy")(function* deploy(sha) {
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

        const attempt = yield* startAttempt(
          ship,
          config,
          sha,
          config.runtime.RAT_KING_VERSION,
          shipping
        );

        const configPath = `${attempt.directory}/stage.json`;
        yield* writePrivateJson(configPath, JSON.stringify(attempt.config));

        const result = yield* execute(
          ship.launchd.node,
          ["stacks/nest/cli.ts", "deploy"],
          release,
          { RAT_KING_STAGE_CONFIG: configPath },
          "candidate deploy"
        );

        return yield* observeAttempt(attempt.events, result);
      }, boundDeploy),
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
