import { it } from "@effect/vitest";
import { Arbitrary, Effect, Option, Result } from "effect";
import { expect } from "vitest";

import {
  pivotReceipt,
  ReaderJournal,
  readerJournal,
  sameReaderIdentity,
} from "../src/reader-journal.ts";

it.effect.prop(
  "shown state becomes deduplicated only after durable save; reload retains every ID and turn key",
  [Arbitrary.schema(ReaderJournal)],
  ([journal]) =>
    Effect.gen(function* durability() {
      let failing = true;
      let saved = journal;

      const displayed = yield* readerJournal({
        pending: Effect.succeed(journal.pending),
        save: (value) =>
          failing
            ? Effect.fail("storage unavailable")
            : Effect.sync(() => {
                saved = value;
              }),
      });

      yield* displayed.restore(journal);

      const id = "i".repeat(
        Math.max(0, ...journal.shownIds.map((value) => value.length)) + 1
      );

      const turn = "t".repeat(
        Math.max(0, ...journal.shownTurns.map((value) => value.length)) + 1
      );

      expect(
        Result.isFailure(yield* Effect.result(displayed.shown(id, turn)))
      ).toBe(true);
      expect(displayed.skips(id)).toBe(false);
      expect(displayed.skips("unseen", turn)).toBe(false);
      failing = false;
      yield* displayed.shown(id, turn);

      const reloaded = yield* readerJournal({
        pending: Effect.succeed(journal.pending),
        save: () => Effect.void,
      });

      yield* reloaded.restore(saved);
      expect(reloaded.skips(id)).toBe(true);
      expect(reloaded.skips("new-envelope", turn)).toBe(true);
      expect(Option.getOrThrow(yield* reloaded.snapshot).shownIds).toEqual([
        ...new Set([...journal.shownIds, id]),
      ]);
      expect(Option.getOrThrow(yield* reloaded.snapshot).shownTurns).toEqual([
        ...new Set([...journal.shownTurns, turn]),
      ]);
      expect(
        sameReaderIdentity(saved, { ...saved, did: `${saved.did}:different` })
      ).toBe(false);
      expect(
        sameReaderIdentity(saved, {
          ...saved,
          keyReference: `${saved.keyReference}:different`,
        })
      ).toBe(false);
      expect(
        sameReaderIdentity(saved, { ...saved, name: `${saved.name}:different` })
      ).toBe(false);
      expect(sameReaderIdentity(saved, saved)).toBe(true);

      const child = {
        ...saved,
        generation: saved.generation + 1,
        session: `${saved.session}:child`,
      };

      const receipt = pivotReceipt(saved, child);
      expect(receipt.before).toEqual(receipt.after);
      expect(receipt.counts.before).toEqual(receipt.counts.after);
    })
);
