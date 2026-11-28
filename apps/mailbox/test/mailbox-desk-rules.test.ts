import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/desk.defs";
import * as Pending from "@rat-king/lexicon/desk.pending";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { Caller } from "../src/caller.ts";
import { DeskStore, deskStore } from "../src/desk-store.ts";
import { DeskHandlers, DeskRegistry, deskHandlers } from "../src/desk.ts";
import { testStoreFor } from "./helpers.ts";
import {
  alpha,
  did,
  epoch,
  integer,
  iso,
  serial,
} from "./mailbox-rule-inputs.ts";

const desk = "did:web:desk.example.invalid";

const storage = testStoreFor(desk);

const registry = Layer.succeed(
  DeskRegistry,
  DeskRegistry.of({
    parent: () => Effect.die("parent not needed"),
    snapshot: () => Effect.die("snapshot not needed"),
  })
);

const params = Schema.decodeUnknownSync(Pending.Params)({ desk });

const makeItem = Schema.decodeUnknownSync(Defs.OwnerItem);

type Kind = Defs.OwnerItemValue["kind"];

const item = (
  n: number,
  at: number,
  kind: Kind = "fyi",
  options: {
    readonly author?: string;
    readonly mention?: string;
    readonly text?: string;
    readonly end?: number;
  } = {}
) => {
  const entry = {
    author: options.author ?? did(n),
    cid: n.toString(16).padStart(32, "0"),
    createdAt: iso(at),
    kind,
    text: options.text ?? "Test report",
    uri: `at://example.invalid/desk/${n}`,
  };

  if (options.mention === undefined) {
    return makeItem(entry);
  }

  return makeItem({
    ...entry,
    facets: [
      {
        features: [
          {
            $type: "sh.mschf.ratking.desk.defs#mention",
            did: options.mention,
          },
        ],
        index: { byteEnd: options.end ?? 1, byteStart: 0 },
      },
    ],
  });
};

const pending = (items: readonly Defs.OwnerItemValue[], now: number) =>
  Effect.gen(function* queueView() {
    const { sql } = yield* storage;
    const layer = deskStore(sql);
    const store = yield* DeskStore.pipe(Effect.provide(layer));
    yield* store.transaction((tx) => {
      for (const entry of items) {
        tx.insert(entry, Date.parse(entry.createdAt));
      }
    });
    yield* TestClock.setTime(now);

    const api = yield* DeskHandlers.pipe(
      Effect.provide(
        deskHandlers(desk, []).pipe(
          Layer.provide(
            Layer.mergeAll(
              layer,
              registry,
              Layer.succeed(Caller, { did: desk })
            )
          )
        )
      )
    );

    return yield* api.pending(params);
  }).pipe(Effect.scoped);

it.effect.prop(
  "pending coverage keeps insertion order even when creation times are reversed",
  [epoch, serial, integer(2, 9)],
  ([now, offset, count]) =>
    Effect.gen(function* stableCoverage() {
      const items = Array.from({ length: count }, (_, i) =>
        item(i + 1, now - i * offset)
      );

      const view = yield* pending(items, now);
      expect(view.covered).toEqual(items.map(({ uri }) => uri));
    })
);

it.effect.prop(
  "oldest quiet age follows the creation timestamp, not queue position",
  [epoch, serial, serial],
  ([now, first, gap]) =>
    Effect.gen(function* oldestQuiet() {
      const view = yield* pending(
        [item(1, now - first), item(2, now - first - gap)],
        now
      );

      expect(view.oldestQuietAgeMs).toBe(first + gap);
      expect(view.oldestQuietAt).toBe(iso(now - first - gap));
    })
);

it.effect.prop(
  "a future producer timestamp cannot create a negative quiet age",
  [epoch, serial],
  ([now, skew]) =>
    Effect.gen(function* futureItem() {
      const view = yield* pending([item(1, now + skew)], now);
      expect(view.oldestQuietAgeMs).toBe(0);
      expect(view.oldestQuietAt).toBe(iso(now + skew));
    })
);

it.effect.prop(
  "a direct mention is not quiet even if it is older than every quiet entry",
  [epoch, serial],
  ([now, age]) =>
    Effect.gen(function* excludedMention() {
      const items = [
        item(1, now - 2 * age, "action", { mention: desk }),
        item(2, now - age),
      ];

      const view = yield* pending(items, now);
      expect(view.mentions.map(({ seq }) => seq)).toEqual([1]);
      expect(view.oldestQuietAgeMs).toBe(age);
    })
);

it.effect.prop(
  "a mention-only queue omits quiet timing altogether",
  [epoch, integer(1, 10)],
  ([now, size]) =>
    Effect.gen(function* onlyMentions() {
      const items = Array.from({ length: size }, (_, i) =>
        item(i + 1, now - i, "fyi", { mention: desk })
      );

      const view = yield* pending(items, now);
      expect(view.mentions).toHaveLength(size);
      expect(view).not.toHaveProperty("oldestQuietAt");
      expect(view).not.toHaveProperty("oldestQuietAgeMs");
    })
);

it.effect.prop(
  "a facet for another DID remains quiet in the current desk's view",
  [epoch, serial],
  ([now, n]) =>
    Effect.gen(function* foreignMention() {
      const view = yield* pending(
        [item(1, now - n, "action", { mention: did(n) })],
        now
      );

      expect(view.mentions).toEqual([]);
      expect(view.oldestQuietAgeMs).toBe(n);
    })
);

it.effect.prop(
  "report text alone does not count as a desk mention without a facet",
  [epoch, alpha],
  ([now, stem]) =>
    Effect.gen(function* noImplicitMention() {
      const view = yield* pending(
        [item(1, now, "action", { text: `@${desk} ${stem}` })],
        now
      );

      expect(view.mentions).toEqual([]);
      expect(view.oldestQuietAgeMs).toBe(0);
    })
);

it.effect.prop(
  "the pending view uses a one-row lookahead without adding it to coverage or digest",
  [epoch, integer(0, 4)],
  ([now, extra]) =>
    Effect.gen(function* projectedWindow() {
      const count = 200 + extra;

      const items = Array.from({ length: count }, (_, i) =>
        item(i + 1, now - i)
      );

      const view = yield* pending(items, now);
      expect(view.covered).toHaveLength(200);
      expect(view.covered.at(-1)).toBe(items[199]?.uri);
      expect(view.digest).toHaveLength(200);
      expect(view.more).toBe(extra > 0);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 8 } }
);

it.effect.prop(
  "quiet progress is coalesced per author without losing covered sequence numbers",
  [epoch, serial],
  ([now, n]) =>
    Effect.gen(function* progressPerAuthor() {
      const author = did(n);

      const items = [
        item(1, now - 3, "progress", { author }),
        item(2, now - 2, "progress", { author: did(n + 1) }),
        item(3, now - 1, "progress", { author }),
      ];

      const view = yield* pending(items, now);
      expect(view.covered).toEqual(items.map(({ uri }) => uri));
      expect(
        view.digest.map(({ seq }) => seq).toSorted((a, b) => a - b)
      ).toEqual([2, 3]);
    })
);

it.effect.prop(
  "mentioned progress survives a later quiet progress update from the same author",
  [epoch, serial],
  ([now, n]) =>
    Effect.gen(function* protectedMention() {
      const author = did(n);

      const view = yield* pending(
        [
          item(1, now - 2, "progress", { author, mention: desk }),
          item(2, now - 1, "progress", { author }),
        ],
        now
      );

      expect(view.digest.map(({ seq }) => seq)).toEqual([1, 2]);
    })
);

it.effect.prop(
  "quiet digest groups entries by author without changing order within each group",
  [epoch, serial],
  ([now, n]) =>
    Effect.gen(function* grouped() {
      const author = did(n);
      const other = did(n + 1);

      const view = yield* pending(
        [
          item(1, now - 1, "done", { author }),
          item(2, now - 2, "done", { author: other }),
          item(3, now - 3, "fyi", { author }),
        ],
        now
      );

      expect(view.digest.map(({ seq }) => seq)).toEqual([1, 3, 2]);
    })
);

it.effect.prop(
  "a valid UTF-8 facet can name the desk when its byte end exceeds the character count",
  [epoch, integer(1, 30)],
  ([now, n]) =>
    Effect.gen(function* byteOffsets() {
      const view = yield* pending(
        [
          item(1, now, "fyi", {
            end: n * 4,
            mention: desk,
            text: "💌".repeat(n),
          }),
        ],
        now
      );

      expect(view.mentions.map(({ seq }) => seq)).toEqual([1]);
    })
);
