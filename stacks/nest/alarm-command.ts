import type { Path } from "effect";
import { Clock, Console, Effect, FileSystem, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { SecretStore } from "../../apps/mailbox/cli/secrets.ts";
import { secretStoreLayer } from "../../apps/mailbox/cli/secrets.ts";
import { collectAlarmFacts } from "./alarm-collector.ts";
import { prepareAlarmDeliveries, sendAlarmDelivery } from "./alarm-mail.ts";
import type { DeployMarker } from "./alarm-sources.ts";
import { observeAlarms } from "./alarm-sources.ts";
import { AlarmJournal, alarmCycle, emptyJournal } from "./alarm.ts";
import type { AlarmPorts, AlarmJournalValue } from "./alarm.ts";
import type { HealthDigest } from "./health.ts";
import { execute } from "./ship-command.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const alarmPlist = (config: StageConfigValue, configPath: string) => {
  if (config.alarm === undefined) {
    return "";
  }

  const launch = config.alarm.launchd;
  const string = (value: string) => `<string>${xml(value)}</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key>${string(launch.label)}<key>ProgramArguments</key><array>${[launch.node, `${launch.source}/stacks/nest/cli.ts`, "alarm"].map(string).join("")}</array><key>EnvironmentVariables</key><dict><key>RAT_KING_STAGE_CONFIG</key>${string(configPath)}<key>PATH</key>${string(launch.path)}</dict><key>WorkingDirectory</key>${string(launch.source)}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer><key>StandardOutPath</key>${string(launch.outputLog)}<key>StandardErrorPath</key>${string(launch.errorLog)}</dict></plist>\n`;
};

export const readAlarmJournal = Effect.fn("Alarm.readJournal")(
  function* readAlarmJournal(directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const file = `${directory}/alarms.jsonl`;

    if (!(yield* fs.exists(file))) {
      return emptyJournal;
    }

    if (
      (yield* fs.realPath(file)) !== file ||
      (yield* fs.stat(file)).mode % 0o1000 !== 0o600
    ) {
      return yield* new FleetError({
        reason: "Alarm journal is not a private owned file",
      });
    }

    const last = (yield* fs.readFileString(file)).trim().split("\n").at(-1);

    if (last === undefined || last === "") {
      return emptyJournal;
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(AlarmJournal))(
      last
    ).pipe(
      Effect.mapError(
        () =>
          new FleetError({
            reason:
              "Invalid alarm journal; refused to forget prior notifications",
          })
      )
    );
  }
);

export const alarmWorker = Effect.fn("Alarm.worker")(
  function* alarmWorker<E, R, E2, R2>(
    config: StageConfigValue,
    health: Effect.Effect<HealthDigest, E, R>,
    deploy: Effect.Effect<typeof DeployMarker.Type | null, E2, R2>
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

    const journal = `${directory}/alarms.jsonl`;
    let encoded = "";

    const save = Effect.fn("Alarm.save")(function* save(
      state: AlarmJournalValue
    ) {
      const next = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(state);

      if (next !== encoded) {
        yield* Effect.gen(function* persist() {
          const file = yield* fs.open(journal, { flag: "a", mode: 0o600 });
          yield* file.writeAll(new TextEncoder().encode(`${next}\n`));
          yield* file.sync;
        }).pipe(Effect.scoped);
        encoded = next;
      }
    });

    const unavailable = Console.error(
      "Alarm operation unavailable; input values withheld"
    );

    for (;;) {
      const started = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* cycle() {
        const prior = yield* readAlarmJournal(directory);
        const facts = yield* collectAlarmFacts(config, health, deploy);

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
              )
            ),
          prepare: (key, to, text) =>
            prepareAlarmDeliveries(config, key, to, text).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                () =>
                  new FleetError({
                    reason: "Alarm notification preparation failed",
                  })
              )
            ),
          save: (state) =>
            save(state).pipe(
              Effect.mapError(
                () => new FleetError({ reason: "Alarm journal write failed" })
              )
            ),
          send: (delivery) =>
            sendAlarmDelivery(config, delivery).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                () => new FleetError({ reason: "Alarm delivery failed" })
              )
            ),
          unavailable,
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
        Effect.catch(() => unavailable)
      );
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      yield* Effect.sleep(Math.max(0, 60_000 - elapsed));
    }
  },
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
  function* alarmCheck<E, R, E2, R2>(
    config: StageConfigValue,
    health: Effect.Effect<HealthDigest, E, R>,
    deploy: Effect.Effect<typeof DeployMarker.Type | null, E2, R2>
  ) {
    const facts = yield* collectAlarmFacts(config, health, deploy);
    const fs = yield* FileSystem.FileSystem;

    const prior = yield* readAlarmJournal(
      yield* fs.realPath(config.runtime.RAT_KING_STATE_DIR)
    );

    return observeAlarms(prior.sources, facts, yield* Clock.currentTimeMillis)
      .readings;
  },
  (effect) =>
    effect.pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]))
);
