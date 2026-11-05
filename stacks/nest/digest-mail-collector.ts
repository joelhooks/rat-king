import { Clock, Effect } from "effect";
import { FetchHttpClient } from "effect/http";

import { secretStoreLayer } from "../../apps/mailbox/cli/secrets.ts";
import { collectReaderHeartbeats } from "./alarm-collector.ts";
import { busyMailLines } from "./alarm-stranded.ts";
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

    const wakes = yield* collectWakeHealth(
      config,
      readers.flatMap((reader) => reader.targets)
    );

    return busyMailLines(wakes ?? [], yield* Clock.currentTimeMillis);
  },
  (effect) =>
    effect.pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]))
);
