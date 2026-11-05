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

          const defaultUnackedMinutes = config.alarm?.wakeUnackedMinutes;

          return {
            ...reader,
            health,
            retired: retirement,
            ...(turn === null
              ? undefined
              : { lastTurnAt: Date.parse(turn.at) }),
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
