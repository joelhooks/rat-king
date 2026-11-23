import type { EntryValue } from "@rat-king/lexicon/mailbox.listTraffic";
import { Context, Effect, Layer, Ref, Schedule, Stream } from "effect";

import { Unavailable } from "./client.ts";
import type { TrafficSource } from "./client.ts";
import { projectTraffic } from "./view.ts";
import type { Project } from "./view.ts";

const PAGE_SIZE = 100;

export const WINDOW = 500;

export interface Snapshot {
  readonly revision: number;
  readonly watermark: number | null;
  readonly status: "connecting" | "live" | "reconnecting";
  readonly projects: readonly Project[];
}

export const emptySnapshot: Snapshot = {
  projects: [],
  revision: 0,
  status: "connecting",
  watermark: null,
};

const makeFeed = Effect.fn("TrafficViewer.makeFeed")(function* makeFeed(
  source: TrafficSource
) {
  const current = yield* Ref.make(emptySnapshot);
  let events: readonly EntryValue[] = [];

  const catchUp = Effect.fn("TrafficViewer.catchUp")(function* catchUp(
    through: number
  ) {
    const prior = yield* Ref.get(current);

    if (prior.watermark === through) {
      if (prior.status !== "live") {
        yield* Ref.set<Snapshot>(current, {
          ...prior,
          revision: prior.revision + 1,
          status: "live",
        });
      }

      return yield* Effect.void;
    }

    const floor = Math.max(0, through - WINDOW);
    const reset = prior.watermark === null || prior.watermark > through;
    let cursor = reset ? floor : Math.max(floor, prior.watermark ?? floor);
    const history = reset ? [] : events.filter((event) => event.seq > floor);

    for (let page = 0; page < WINDOW / PAGE_SIZE; page += 1) {
      const batch = yield* source.list(cursor);

      for (const event of batch.events) {
        if (event.seq <= cursor) {
          return yield* new Unavailable();
        }

        cursor = event.seq;

        if (event.seq <= through) {
          history.push(event);
        }
      }

      if ((cursor === 0 && through === 0) || cursor >= through) {
        events = history;
        yield* Ref.set<Snapshot>(current, {
          projects: projectTraffic(events),
          revision: prior.revision + 1,
          status: "live",
          watermark: through,
        });

        return yield* Effect.void;
      }

      if (batch.events.length < PAGE_SIZE) {
        break;
      }
    }

    return yield* new Unavailable();
  });

  const disconnected = Ref.update<Snapshot>(current, (prior) =>
    prior.status === "reconnecting"
      ? prior
      : { ...prior, revision: prior.revision + 1, status: "reconnecting" }
  );

  const run = source.notices.pipe(
    Stream.runForEach(catchUp),
    Effect.ignore,
    Effect.andThen(disconnected),
    Effect.repeat(Schedule.spaced("2 seconds")),
    Effect.asVoid
  );

  return { read: Ref.get(current), run };
});

export class Feed extends Context.Service<
  Feed,
  {
    readonly read: Effect.Effect<Snapshot>;
    readonly run: Effect.Effect<void>;
  }
>()("TrafficViewer/Feed") {}

export const feedLayer = (source: TrafficSource) =>
  Layer.effect(Feed, makeFeed(source));
