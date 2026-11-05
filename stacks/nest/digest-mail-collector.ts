import { Clock, Effect } from "effect";
import { FetchHttpClient } from "effect/http";

import { secretStoreLayer } from "../../apps/mailbox/cli/secrets.ts";
import { collectReaderHeartbeats } from "./alarm-collector.ts";
import { readAlarmJournal } from "./alarm-command.ts";
import {
  busyMailLines,
  abandonedMailLines,
  strandedMailLines,
} from "./alarm-stranded.ts";
import { collectWakeHealth } from "./alarm-wake-collector.ts";
import type { StageConfigValue } from "./stage-config.ts";

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

    const now = yield* Clock.currentTimeMillis;

    return [
      ...strandedMailLines(wakes ?? [], now),
      ...busyMailLines(wakes ?? [], now),
      ...abandonedMailLines(wakes ?? [], now),
    ];
  },
  (effect) =>
    effect.pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]))
);
