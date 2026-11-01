import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";

export const advanceClock = Effect.forever(
  Effect.yieldNow.pipe(Effect.andThen(TestClock.adjust(Duration.minutes(10))))
);
