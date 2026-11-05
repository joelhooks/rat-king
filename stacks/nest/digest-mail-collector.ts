import { Clock, Effect } from "effect";
import { FetchHttpClient } from "effect/http";

import { secretStoreLayer } from "../../apps/mailbox/cli/secrets.ts";
import { collectReaderHeartbeats } from "./alarm-collector.ts";
import { readAlarmJournal } from "./alarm-command.ts";
import { prepareAlarmMail } from "./alarm-mail.ts";
import {
  busyMailLines,
  abandonedMailLines,
  strandedMailLines,
} from "./alarm-stranded.ts";
import { collectWakeHealth } from "./alarm-wake-collector.ts";
import type { WakeSighting } from "./alarm-wakes.ts";
import type { StageConfigValue } from "./stage-config.ts";

export const digestRetirementObservations = Effect.fn(
  "Digest.retirementObservations"
)(function* digestRetirementObservations<E, R>(
  seen: readonly (typeof WakeSighting.Type)[],
  scan: Effect.Effect<readonly string[], E, R>
) {
  if (
    !seen.some(
      (item) => item.health !== null && item.health.retired === undefined
    )
  ) {
    return seen;
  }

  const retired = yield* scan.pipe(Effect.orElseSucceed(() => null));

  return retired === null
    ? seen
    : seen.map((item) => ({
        ...item,
        retired: item.retired ?? retired.includes(item.name),
      }));
});

export const collectDigestWaitingMail = Effect.fn(
  "Nest.collectDigestWaitingMail"
)(
  function* collectDigestWaitingMail(config: StageConfigValue) {
    const readers = yield* Effect.forEach(
      config.alarm?.readerHeartbeats ?? [],
      (source) =>
        collectReaderHeartbeats(source).pipe(
          Effect.orElseSucceed(() => ({ targets: [] }))
        ),
      { concurrency: "unbounded" }
    );

    const previous = yield* readAlarmJournal(
      config.runtime.RAT_KING_STATE_DIR
    ).pipe(Effect.orElseSucceed(() => null));

    const wakes = yield* collectWakeHealth(
      config,
      readers.flatMap((reader) => reader.targets),
      previous?.sources.wakeTargets
    );

    const observations = yield* digestRetirementObservations(
      wakes ?? [],
      prepareAlarmMail(config, [], "", true).pipe(
        Effect.flatMap((prepared) => prepared.client.retirements()),
        Effect.scoped
      )
    );

    const now = yield* Clock.currentTimeMillis;

    return [
      ...strandedMailLines(observations, now),
      ...busyMailLines(observations, now),
      ...abandonedMailLines(observations, now),
    ];
  },
  (effect) =>
    effect.pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]))
);
