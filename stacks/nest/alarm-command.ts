import type { Path } from "effect";
import { Clock, Console, Effect, FileSystem, Ref, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { FetchHttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import type { SecretStore } from "../../apps/mailbox/cli/secrets.ts";
import { secretStoreLayer } from "../../apps/mailbox/cli/secrets.ts";
import { collectAlarmFacts, withLiveness } from "./alarm-collector.ts";
import type { AlarmHeartbeat } from "./alarm-heartbeat.ts";
import {
  alarmFailure,
  alarmStep,
  checkAlarmWorkerHealth,
  nextAlarmHeartbeat,
  readAlarmHeartbeat,
  writeAlarmHeartbeat,
} from "./alarm-heartbeat.ts";
import { readAlarmJournal, saveAlarmJournal } from "./alarm-journal.ts";
import {
  deskWakeMail,
  prepareAlarmDeliveries,
  sendAlarmDelivery,
  withAlarmMailTransport,
} from "./alarm-mail.ts";
import { collectPush, dispatchPush, loadAlarmPush } from "./alarm-push.ts";
import { updateReaderWindows } from "./alarm-reader-windows.ts";
import type { ReaderWindowObservation } from "./alarm-reader-windows.ts";
import type {
  AlarmFacts,
  DeployMarker,
  WindowReceipt,
} from "./alarm-sources.ts";
import { observeAlarms } from "./alarm-sources.ts";
import {
  collectDeskWakeHealth,
  collectWakeHealth,
} from "./alarm-wake-collector.ts";
import { AlarmJournal, deskWakeReadings, runAlarmCycle } from "./alarm.ts";
import type { AlarmPorts, AlarmJournalValue } from "./alarm.ts";
import type { HealthDigest } from "./health.ts";
import { rotateLogs } from "./log-rotation.ts";
import { execute, runnerDrift } from "./ship-command.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";
import { watchReaderCrashes } from "./turn-crashes.ts";

export { alarmPlist } from "./alarm-service.ts";

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
    const launch = settings.systemd ?? settings.launchd;
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.realPath(config.runtime.RAT_KING_STATE_DIR);

    if ((yield* fs.stat(directory)).mode % 0o1000 !== 0o700) {
      return yield* new FleetError({
        reason: "Alarm state directory must be private",
      });
    }

    const readerWindows = yield* Ref.make<ReaderWindowObservation | null>(null);
    const push = yield* loadAlarmPush(settings.push);

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
        [launch.outputLog, launch.errorLog],
        yield* Clock.currentTimeMillis
      );

      if (yield* drifted) {
        return yield* Console.log(
          JSON.stringify({
            runner: "code changed; exiting for supervisor restart",
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

        const facts = collectAlarmFacts(
          config,
          health,
          deploy,
          (readers) =>
            collectWakeHealth(config, readers, prior.sources.wakeTargets),
          windows,
          withLiveness(liveness)
        ).pipe(
          (effect) => alarmStep("facts.collect", effect),
          Effect.tap((observed) =>
            Effect.gen(function* reportFacts() {
              const observedAt = yield* Clock.currentTimeMillis;

              yield* Ref.update(readerWindows, (previous) =>
                updateReaderWindows(previous, observed, observedAt)
              );

              yield* reportMissing(observed);
            })
          )
        );

        const ports: AlarmPorts<
          | FileSystem.FileSystem
          | HttpClient.HttpClient
          | Path.Path
          | SecretStore
          | ChildProcessSpawner.ChildProcessSpawner
        > = {
          deskWake: deskWakeMail(config),
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

        const main = runAlarmCycle(
          prior,
          facts,
          collectDeskWakeHealth(config),
          settings,
          ports
        );

        if (push === null || settings.push === undefined) {
          yield* main;

          return;
        }

        const [journal, seen] = yield* Effect.all(
          [main, collectPush(config, settings.push.names)],
          { concurrency: "unbounded" }
        );

        yield* dispatchPush(
          journal.pushAttempts ?? {},
          seen,
          push,
          (pushAttempts) => save({ ...journal, pushAttempts })
        );
      }).pipe(
        withAlarmMailTransport,
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

      yield* checkAlarmWorkerHealth(heartbeat);

      const elapsed = (yield* Clock.currentTimeMillis) - started;
      yield* Effect.sleep(Math.max(0, 60_000 - elapsed));
    }
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]))
);

export const alarmReadings = Effect.fn("Alarm.readings")(
  function* alarmReadings<E, R, E2, R2, E4 = never, R4 = never>(
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

    const { readings } = observeAlarms(
      prior.sources,
      facts,
      yield* Clock.currentTimeMillis
    );

    const settings = config.alarm;

    return settings === undefined
      ? readings
      : { ...readings, ...deskWakeReadings(prior, settings) };
  },
  (effect) =>
    effect.pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]))
);
