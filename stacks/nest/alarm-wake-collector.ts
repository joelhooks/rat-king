import { Clock, Effect } from "effect";

import { prepareAlarmMail } from "./alarm-mail.ts";
import { needsTurnHealth } from "./alarm-stranded.ts";
import { mergeWakeTargets } from "./alarm-wakes.ts";
import type { WakeTarget } from "./alarm-wakes.ts";
import type { StageConfigValue } from "./stage-config.ts";

export const collectWakeHealth = Effect.fn("Alarm.collectWakeHealth")(
  function* collectWakeHealth(
    config: StageConfigValue,
    readers?: readonly (typeof WakeTarget.Type)[],
    previous: readonly (typeof WakeTarget.Type)[] = []
  ) {
    const configured = config.alarm?.wakeTargets ?? [];

    if (
      readers === undefined &&
      previous.length === 0 &&
      configured.length === 0
    ) {
      return null;
    }

    const unique =
      mergeWakeTargets([...previous, ...(readers ?? [])], configured) ?? [];

    if (unique.length === 0) {
      return [];
    }

    const prepared = yield* prepareAlarmMail(
      config,
      unique.map((reader) => reader.name),
      "",
      true
    );

    const now = yield* Clock.currentTimeMillis;

    return yield* Effect.forEach(
      unique,
      (reader) =>
        Effect.gen(function* observe() {
          const target = prepared.targets.find(
            (item) => item.name === reader.name
          );

          const health =
            target === undefined
              ? null
              : yield* prepared.client
                  .health(target.did, target.name)
                  .pipe(Effect.orElseSucceed(() => null));

          const retirement = health?.retired ?? null;

          const turn =
            health?.lastTurnStartedAt !== undefined ||
            config.alarm?.notify.sender !== undefined ||
            target === undefined ||
            health?.lease === null ||
            health === null ||
            !needsTurnHealth({ ...reader, health, retired: retirement }, now)
              ? null
              : yield* prepared.client
                  .turnHealth(
                    target.did,
                    target.name,
                    health.lease.holder,
                    true
                  )
                  .pipe(Effect.orElseSucceed(() => null));

          const lastTurn =
            health?.lastTurnStartedAt ??
            (turn === null ? undefined : Date.parse(turn.at));

          const defaultUnackedMinutes = config.alarm?.wakeUnackedMinutes;

          return {
            ...reader,
            health,
            retired: retirement,
            ...(lastTurn === undefined ? undefined : { lastTurnAt: lastTurn }),
            ...(defaultUnackedMinutes === undefined
              ? undefined
              : { defaultUnackedMinutes }),
          };
        }),
      { concurrency: 4 }
    );
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() => null)
    )
);

export const collectDeskWakeHealth = Effect.fn("Alarm.collectDeskWakeHealth")(
  function* collectDeskWakeHealth(config: StageConfigValue) {
    const desks = new Set(config.alarm?.wakeOnMail?.map(({ name }) => name));

    if (desks.size === 0) {
      return [];
    }

    const { client, targets } = yield* prepareAlarmMail(
      config,
      [...desks],
      "",
      true
    );

    return yield* Effect.forEach(
      desks,
      (name) => {
        const target = targets.find((candidate) => candidate.name === name);

        return target === undefined
          ? Effect.succeed({ health: null, name })
          : client.health(target.did, name).pipe(
              Effect.orElseSucceed(() => null),
              Effect.map((health) => ({ health, name }))
            );
      },
      { concurrency: 4 }
    );
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() => null)
    )
);
