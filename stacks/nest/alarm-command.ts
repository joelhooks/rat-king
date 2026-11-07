import type { Path } from "effect";
import { Clock, Console, Effect, FileSystem, Ref, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { SecretStore } from "../../apps/mailbox/cli/secrets.ts";
import { secretStoreLayer } from "../../apps/mailbox/cli/secrets.ts";
import { collectAlarmFacts, withLiveness } from "./alarm-collector.ts";
import type { AlarmHeartbeat } from "./alarm-heartbeat.ts";
import {
  alarmFailure,
  alarmStep,
  nextAlarmHeartbeat,
  readAlarmHeartbeat,
  writeAlarmHeartbeat,
} from "./alarm-heartbeat.ts";
import { readAlarmJournal, saveAlarmJournal } from "./alarm-journal.ts";
import { prepareAlarmDeliveries, sendAlarmDelivery } from "./alarm-mail.ts";
import { updateReaderWindows } from "./alarm-reader-windows.ts";
import type { ReaderWindowObservation } from "./alarm-reader-windows.ts";
import type {
  AlarmFacts,
  DeployMarker,
  WindowReceipt,
} from "./alarm-sources.ts";
import { observeAlarms } from "./alarm-sources.ts";
import { collectWakeHealth } from "./alarm-wake-collector.ts";
import { AlarmJournal, alarmCycle } from "./alarm.ts";
import type { AlarmPorts, AlarmJournalValue } from "./alarm.ts";
import type { HealthDigest } from "./health.ts";
import { rotateLogs } from "./log-rotation.ts";
import { execute, runnerDrift } from "./ship-command.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";
import { watchReaderCrashes } from "./turn-crashes.ts";

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const string = (value: string) => `<string>${xml(value)}</string>`;

export const alarmPlist = (config: StageConfigValue, configPath: string) => {
  if (config.alarm === undefined) {
    return "";
  }

  const launch = config.alarm.launchd;

  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key>${string(launch.label)}<key>ProgramArguments</key><array>${[launch.node, `${launch.source}/stacks/nest/cli.ts`, "alarm"].map(string).join("")}</array><key>EnvironmentVariables</key><dict><key>RAT_KING_STAGE_CONFIG</key>${string(configPath)}<key>PATH</key>${string(launch.path)}</dict><key>WorkingDirectory</key>${string(launch.source)}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer><key>StandardOutPath</key>${string(launch.outputLog)}<key>StandardErrorPath</key>${string(launch.errorLog)}</dict></plist>\n`;
};

export { readAlarmJournal } from "./alarm-journal.ts";

const reportMissing = (facts: typeof AlarmFacts.Type) =>
  facts.failed === undefined || facts.failed.length === 0
    ? Effect.void
    : Console.log(
        JSON.stringify({
          health: facts.health,
          measurementsUnavailable: facts.failed,
        })
      );

export const alarmWorker = Effect.fn("Alarm.worker")(
  function* alarmWorker<E, R, E2, R2, E4 = never, R4 = never>(
    config: StageConfigValue,
    health: Effect.Effect<HealthDigest, E, R>,
    deploy: Effect.Effect<typeof DeployMarker.Type | null, E2, R2>,
    windows?: Effect.Effect<readonly (typeof WindowReceipt.Type)[], E4, R4>,
    liveness?: Effect.Effect<number, FleetError>
  ) {
    if (
      config.alarm?.enabled !== true ||
      process.env.RAT_KING_ALARM_WORKER !== "locked"
    ) {
      return yield* new FleetError({
        reason:
          "Alarm worker requires enabled configuration and the lock-owning launcher",
      });
    }

    const settings = config.alarm;
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.realPath(config.runtime.RAT_KING_STATE_DIR);

    if ((yield* fs.stat(directory)).mode % 0o1000 !== 0o700) {
      return yield* new FleetError({
        reason: "Alarm state directory must be private",
      });
    }

    const readerWindows = yield* Ref.make<ReaderWindowObservation | null>(null);

    yield* watchReaderCrashes(config, directory, Ref.get(readerWindows));

    let encoded = "";

    const save = Effect.fn("Alarm.save")(function* save(
      state: AlarmJournalValue
    ) {
      const next = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(state);

      if (next !== encoded) {
        yield* saveAlarmJournal(directory, state);
        encoded = next;
      }
    });

    const unavailable = Console.error(
      "Alarm operation unavailable; input values withheld"
    );

    const drifted = yield* runnerDrift(config.ship?.checkpoint);
    let heartbeat = yield* readAlarmHeartbeat(directory);

    for (;;) {
      yield* rotateLogs(
        [settings.launchd.outputLog, settings.launchd.errorLog],
        yield* Clock.currentTimeMillis
      );

      if (yield* drifted) {
        return yield* Console.log(
          JSON.stringify({
            runner: "code changed; exiting for launchd restart",
          })
        );
      }

      const started = yield* Clock.currentTimeMillis;
      let outcome: (typeof AlarmHeartbeat.Type)["outcome"] = "ok";

      const notification = <A, Failure, Requirements>(
        step: Parameters<typeof alarmStep>[0],
        operation: Effect.Effect<A, Failure, Requirements>
      ) =>
        alarmStep(step, operation).pipe(
          Effect.tapError((failure) =>
            Effect.sync(() => {
              outcome = alarmFailure(failure);
            })
          )
        );

      yield* Effect.gen(function* cycle() {
        const prior = yield* alarmStep(
          "journal.read",
          readAlarmJournal(directory)
        );

        const facts = yield* collectAlarmFacts(
          config,
          health,
          deploy,
          (readers) =>
            collectWakeHealth(config, readers, prior.sources.wakeTargets),
          windows,
          withLiveness(liveness)
        ).pipe((effect) => alarmStep("facts.collect", effect));

        const observedAt = yield* Clock.currentTimeMillis;
        yield* Ref.update(readerWindows, (previous) =>
          updateReaderWindows(previous, facts, observedAt)
        );

        yield* reportMissing(facts);

        const ports: AlarmPorts<
          | FileSystem.FileSystem
          | HttpClient.HttpClient
          | Path.Path
          | SecretStore
          | ChildProcessSpawner.ChildProcessSpawner
        > = {
          page: (text) =>
            execute(
              settings.page.node,
              [settings.page.script, "--kind", "needs_joel", text],
              directory
            ).pipe(
              Effect.timeout("10 seconds"),
              Effect.flatMap((result) =>
                result.code === 0
                  ? Schema.decodeEffect(
                      Schema.fromJsonString(
                        Schema.Struct({ ok: Schema.Literal(true) })
                      )
                    )(result.output).pipe(
                      Effect.asVoid,
                      Effect.mapError(
                        () =>
                          new FleetError({ reason: "Alarm page not accepted" })
                      )
                    )
                  : Effect.fail(new FleetError({ reason: "Alarm page failed" }))
              ),
              Effect.mapError(
                () => new FleetError({ reason: "Alarm page unavailable" })
              ),
              (effect) => notification("notifications.page", effect)
            ),
          prepare: (key, to, text) =>
            prepareAlarmDeliveries(config, key, to, text).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                () =>
                  new FleetError({
                    reason: "Alarm notification preparation failed",
                  })
              ),
              (effect) => notification("notifications.prepare", effect)
            ),
          save: (state) => alarmStep("journal.write", save(state)),
          send: (delivery) =>
            sendAlarmDelivery(config, delivery).pipe(
              Effect.timeout("8 seconds"),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(new FleetError({ reason: "Alarm delivery failed" }))
              ),
              Effect.catchTag("FleetError", () =>
                notification(
                  "notifications.send",
                  Effect.fail(
                    new FleetError({ reason: "Alarm delivery failed" })
                  )
                )
              )
            ),
          unavailable: Effect.suspend(() =>
            Console.error(`${outcome}; input values withheld`)
          ),
        };

        yield* alarmCycle(
          prior,
          facts,
          yield* Clock.currentTimeMillis,
          settings,
          ports
        );
      }).pipe(
        Effect.timeout("55 seconds"),
        (effect) => alarmStep("cycle", effect),
        Effect.catch((error) => {
          outcome = alarmFailure(error);

          return Console.error(`${outcome}; input values withheld`);
        })
      );
      heartbeat = nextAlarmHeartbeat(
        heartbeat,
        yield* Clock.currentTimeMillis,
        outcome
      );
      yield* writeAlarmHeartbeat(directory, heartbeat).pipe(
        Effect.catch(() => unavailable)
      );

      const elapsed = (yield* Clock.currentTimeMillis) - started;
      yield* Effect.sleep(Math.max(0, 60_000 - elapsed));
    }
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]))
);

export const alarmCommand = Effect.fn("Alarm.command")(function* alarmCommand(
  config: StageConfigValue,
  configPath: string
) {
  if (config.alarm?.enabled !== true) {
    return yield* new FleetError({ reason: "Alarms are disabled" });
  }

  const launch = config.alarm.launchd;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const child = yield* spawner.spawn(
    ChildProcess.make(
      "/usr/bin/lockf",
      [
        "-k",
        "-t",
        "0",
        `${config.runtime.RAT_KING_STATE_DIR}/alarm.lock`,
        launch.node,
        `${launch.source}/stacks/nest/cli.ts`,
        "alarm-worker",
      ],
      {
        env: {
          RAT_KING_ALARM_WORKER: "locked",
          RAT_KING_STAGE_CONFIG: configPath,
        },
        extendEnv: true,
        stderr: "inherit",
        stdin: "ignore",
        stdout: "inherit",
      }
    )
  );

  const code = yield* child.exitCode;

  if (code !== 0) {
    return yield* new FleetError({
      reason: "Alarm owner lock unavailable or worker failed",
    });
  }

  return yield* Effect.void;
}, Effect.scoped);

export const alarmCheck = Effect.fn("Alarm.check")(
  function* alarmCheck<E, R, E2, R2, E4 = never, R4 = never>(
    config: StageConfigValue,
    health: Effect.Effect<HealthDigest, E, R>,
    deploy: Effect.Effect<typeof DeployMarker.Type | null, E2, R2>,
    windows?: Effect.Effect<readonly (typeof WindowReceipt.Type)[], E4, R4>,
    liveness?: Effect.Effect<number, FleetError>
  ) {
    const fs = yield* FileSystem.FileSystem;

    const prior = yield* readAlarmJournal(
      yield* fs.realPath(config.runtime.RAT_KING_STATE_DIR)
    );

    const facts = yield* collectAlarmFacts(
      config,
      health,
      deploy,
      (readers) =>
        collectWakeHealth(config, readers, prior.sources.wakeTargets),
      windows,
      withLiveness(liveness)
    );

    return observeAlarms(prior.sources, facts, yield* Clock.currentTimeMillis)
      .readings;
  },
  (effect) =>
    effect.pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]))
);
