import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, FileSystem, Option } from "effect";
import { expect } from "vitest";

import { ReaderJournal } from "../src/reader-journal.ts";
import { checkpointPermitted, readerStore } from "../src/reader-store.ts";

it.live.prop(
  "a late parent checkpoint and a same-generation rival are no-ops under the per-name lock, including racing writers",
  [Arbitrary.schema(ReaderJournal)],
  ([value]) =>
    Effect.gen(function* checkpointFence() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const store = readerStore(state, "tester");

      const parent = {
        ...value,
        generation: 1,
        name: "tester",
        session: "parent",
      };

      const child = { ...parent, generation: 2, session: "child" };

      yield* Effect.all([store.save(child), store.save(parent)], {
        concurrency: "unbounded",
      });
      expect(yield* store.load).toEqual(Option.some(child));
      const rival = { ...child, session: "unrelated", shownIds: ["discarded"] };
      expect(checkpointPermitted(child, parent)).toBe(false);
      expect(checkpointPermitted(child, rival)).toBe(false);
      yield* store.save(rival);
      yield* store.save(parent);
      expect(yield* store.load).toEqual(Option.some(child));
      const updated = { ...child, shownIds: [...child.shownIds, "latest"] };
      expect(checkpointPermitted(child, updated)).toBe(true);
      yield* store.save(updated);
      expect(yield* store.load).toEqual(Option.some(updated));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 } }
);
