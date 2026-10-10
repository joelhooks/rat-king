import { Duration, Effect } from "effect";

import type { ShipAttempt } from "./ship-config.ts";

export const announceRestart = Effect.fn("Ship.announceRestart")(
  function* announceRestart<E, R>(
    attempt: typeof ShipAttempt.Type,
    send: (text: string) => Effect.Effect<void, E, R>
  ) {
    const seconds = attempt.restart.noticeSeconds ?? 60;
    yield* send(
      `celld restart in ~${seconds} s for ${attempt.sha.slice(0, 12)} SR 🐀`
    );
    yield* Effect.sleep(Duration.seconds(seconds));
  }
);
