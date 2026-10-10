import type { Path } from "effect";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  SecretStore,
  secretStoreLayer,
} from "../../apps/mailbox/cli/secrets.ts";
import {
  ownIdentity,
  prepare,
  SendOutcomes,
  Identity,
} from "../../packages/mailbox-client/src/index.ts";
import {
  Entries,
  writePrivateJson,
} from "../../packages/pi-ratking/src/directory.ts";
import { encodePayload } from "../../packages/pi-ratking/src/payload.ts";
import {
  RestartEvent,
  Sha,
  ShipCheckpoint,
  ShipReceipt,
} from "./ship-config.ts";
import { shipLoop } from "./ship.ts";
import type { ShipPorts } from "./ship.ts";
import { FleetError } from "./stage-config.ts";
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

const execute = Effect.fn("Ship.execute")(
  function* execute(
    command: string,
    args: readonly string[],
    cwd: string,
    env?: Readonly<{ RAT_KING_STAGE_CONFIG: string }>
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, { cwd, env, stdin: "ignore" })
    );

    let output = "";

    const [code] = yield* Effect.all(
      [
        handle.exitCode,
        Stream.runForEach(handle.stdout.pipe(Stream.decodeText()), (text) =>
          Effect.sync(() => {
            if (output.length < 1_048_576) {
              output += text.slice(0, 1_048_576 - output.length);
            }
          })
        ),
        Stream.runDrain(handle.stderr),
      ],
      { concurrency: "unbounded" }
    );

    return { code: Number(code), output };
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.mapError(
        () => new FleetError({ reason: "Ship command failed; values redacted" })
      )
    )
);

const requireSuccess = Effect.fn("Ship.requireSuccess")(
  function* requireSuccess(
    command: string,
    args: readonly string[],
    cwd: string
  ) {
    const result = yield* execute(command, args, cwd);

    if (result.code !== 0) {
      return yield* new FleetError({
        reason: "Ship command returned failure; values redacted",
      });
    }

    return result.output;
  }
);

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const launchdPlist = (config: StageConfigValue, configPath: string) => {
  const { ship } = config;

  if (ship === undefined) {
    return "";
  }

  const string = (text: string) => `<string>${escapeXml(text)}</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key>${string(ship.launchd.label)}<key>ProgramArguments</key><array>${[ship.launchd.node, `${ship.source}/stacks/nest/cli.ts`, "ship"].map(string).join("")}</array><key>EnvironmentVariables</key><dict><key>RAT_KING_STAGE_CONFIG</key>${string(configPath)}<key>PATH</key>${string(ship.launchd.path)}</dict><key>WorkingDirectory</key>${string(ship.source)}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key>${string(ship.launchd.outputLog)}<key>StandardErrorPath</key>${string(ship.launchd.errorLog)}</dict></plist>\n`;
};

export const shipCommand = Effect.fn("Ship.command")(
  function* shipCommand(config: StageConfigValue) {
    const { ship } = config;

    if (ship === undefined) {
      return yield* new FleetError({ reason: "Ship configuration required" });
    }

    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;
    const store = yield* SecretStore;
    yield* fs.makeDirectory(ship.releases, { mode: 0o700, recursive: true });

    const saved = (yield* fs.exists(ship.checkpoint))
      ? yield* Schema.decodeEffect(Schema.fromJsonString(ShipCheckpoint))(
          yield* fs.readFileString(ship.checkpoint)
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
          JSON.stringify({ failed: state.failed, successful: state.successful })
        ).pipe(
          Effect.mapError(
            () => new FleetError({ reason: "Ship checkpoint write failed" })
          )
        ),
      ci: Effect.fn("Ship.fence")(
        function* fence(sha) {
          const checks = yield* Schema.decodeEffect(
            Schema.fromJsonString(Checks)
          )(
            yield* requireSuccess(
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
              () =>
                new FleetError({
                  reason: "Fence workflow evidence unavailable",
                })
            )
          )
      ),
      deploy: Effect.fn("Ship.deploy")(
        function* deploy(sha) {
          const release = `${ship.releases}/${sha}`;

          if (!(yield* fs.exists(release))) {
            yield* requireSuccess(
              "git",
              [
                "clone",
                "--local",
                "--no-hardlinks",
                "--no-checkout",
                "--",
                ship.source,
                release,
              ],
              ship.source
            );
            yield* requireSuccess(
              "git",
              ["checkout", "--detach", sha],
              release
            );
          }

          const current = (yield* requireSuccess(
            "git",
            ["rev-parse", "HEAD"],
            release
          )).trim();

          if (
            current !== sha ||
            (yield* requireSuccess(
              "git",
              ["status", "--porcelain"],
              release
            )).trim() !== ""
          ) {
            return yield* new FleetError({
              reason: "Candidate checkout does not match the fenced SHA",
            });
          }

          yield* requireSuccess(
            ship.launchd.pnpm,
            ["install", "--frozen-lockfile"],
            release
          );

          const attemptDirectory = yield* fs.makeTempDirectory({
            directory: ship.releases,
            prefix: "attempt-",
          });

          const events = `${attemptDirectory}/restart-events.jsonl`;
          const configPath = `${attemptDirectory}/stage.json`;
          yield* fs.writeFileString(events, "", { flag: "wx", mode: 0o600 });
          yield* writePrivateJson(
            configPath,
            JSON.stringify({
              ...config,
              runtime: { ...config.runtime, RAT_KING_COMMIT: sha },
              shipAttempt: { events, restart: ship.restart, sha },
            })
          );

          const result = yield* execute(
            ship.launchd.node,
            ["stacks/nest/cli.ts", "deploy"],
            release,
            { RAT_KING_STAGE_CONFIG: configPath }
          );

          const observations = yield* Effect.forEach(
            (yield* fs.readFileString(events))
              .split("\n")
              .filter((line) => line !== ""),
            (line) =>
              Schema.decodeEffect(Schema.fromJsonString(RestartEvent))(line)
          );

          const last = observations.at(-1);

          const restarted = observations.some(
            (event) => event.restarted === true
          );

          let outcome: (typeof ShipReceipt.Type)["result"] = "failed";

          if (result.code === 0) {
            outcome = "success";
          } else if (last?.phase === "deferred") {
            outcome = "deferred";
          }

          return {
            celldRestarted:
              restarted || (last?.restarted === null ? null : false),
            restartSeconds:
              last?.restarted === null
                ? null
                : observations.reduce(
                    (duration, event) => duration + event.durationSeconds,
                    0
                  ),
            result: outcome,
          };
        },
        (effect) =>
          effect.pipe(
            Effect.timeout("20 minutes"),
            Effect.mapError(
              () =>
                new FleetError({
                  reason:
                    "Candidate deploy failed; receipt must mark restart outcome unknown",
                })
            )
          )
      ),
      fetch: Effect.gen(function* fetch() {
        yield* requireSuccess("git", ["fetch", "origin", "main"], ship.source);

        return yield* Schema.decodeEffect(Sha)(
          (yield* requireSuccess(
            "git",
            ["rev-parse", "origin/main"],
            ship.source
          )).trim()
        );
      }).pipe(
        Effect.timeout("60 seconds"),
        Effect.mapError(() => new FleetError({ reason: "Main fetch failed" }))
      ),
      notify: Effect.fn("Ship.notify")(
        function* notify(receipt) {
          const entries = yield* Schema.decodeEffect(
            Schema.fromJsonString(Entries)
          )(yield* fs.readFileString(ship.notify.directory));

          const identity = yield* Schema.decodeEffect(
            Schema.fromJsonString(Identity)
          )(yield* store.lease(ship.notify.secret));

          const own = yield* ownIdentity(identity);

          const body = yield* encodePayload({
            body: `ship ${receipt.sha.slice(0, 12)} ${receipt.result}; celld restart=${receipt.celldRestarted ?? "unknown"}; restart ${receipt.restartSeconds === null ? "unknown" : receipt.restartSeconds.toFixed(3)}s SR 🐀`,
            from: ship.notify.from,
            kind: "message",
          });

          for (const name of ship.notify.to) {
            const target = entries[name];

            if (target === undefined) {
              return yield* new FleetError({
                reason: "Configured notification name is not in the directory",
              });
            }

            const client = yield* prepare({
              endpoint: config.runtime.RAT_KING_ENDPOINT,
              own,
              peers: [target.document],
              serviceDid: config.runtime.RAT_KING_SERVICE_DID,
            });

            const envelope = yield* client.seal(target.did, body, {
              encrypt: true,
            });

            const outcome = yield* client.send(envelope);

            if (!SendOutcomes.$is("Accepted")(outcome)) {
              return yield* new FleetError({
                reason: "Ship note was not accepted by Rat King",
              });
            }
          }

          return yield* Effect.void;
        },
        Effect.scoped,
        (effect) =>
          effect.pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              () => new FleetError({ reason: "Ship notification failed" })
            )
          )
      ),
      record: (receipt) =>
        Schema.encodeEffect(Schema.fromJsonString(ShipReceipt))(receipt).pipe(
          Effect.flatMap((line) =>
            fs.writeFileString(ship.receipts, `${line}\n`, {
              flag: "a",
              mode: 0o600,
            })
          ),
          Effect.mapError(
            () => new FleetError({ reason: "Deploy receipt write failed" })
          )
        ),
    };

    return yield* shipLoop(ports, saved, ship.intervalSeconds);
  },
  (effect) =>
    effect.pipe(
      Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]),
      Effect.mapError(
        () =>
          new FleetError({
            reason:
              "Ship stopped; check checkpoint and receipts before restarting",
          })
      )
    )
);
