import { Clock, Effect, Schema } from "effect";

import type { CiteRefValue, MemoryRecordValue } from "./contract.ts";
import { Failure, MemoryRecord, SliceSource, Store } from "./contract.ts";
import { safeEvidenceQuote, sha256 } from "./pipeline.ts";

export const SearchInput = Schema.Struct({
  project: Schema.NullOr(Schema.NonEmptyString),
  text: Schema.NonEmptyString,
});

export const RecallHit = Schema.Struct({
  age_ms: Schema.Finite,
  quotes: Schema.Array(
    Schema.Struct({
      status: Schema.Literals(["verified", "unavailable", "stale"]),
      text: Schema.NullOr(Schema.String),
    })
  ),
  record: MemoryRecord,
});

export type RecallHitValue = typeof RecallHit.Type;

export const recallHelp =
  "Search valid claims and cite references. Quotes appear only when SliceSource can resolve and verify them; unavailable, private or changed evidence never appears as a quote. Search does not log use. Log only a result you actually act on with remembers_use.";

const priority = (record: MemoryRecordValue) =>
  ["policy", "product_rule", "decision", "preference"].includes(
    record.claim.type
  )
    ? 1
    : 0;

const salience = (record: MemoryRecordValue, now: number) =>
  Math.log1p(
    [...record.uses, ...record.reobserved].reduce(
      (sum, event) =>
        sum + 1 / Math.sqrt(1 + Math.max(0, now - event.at) / 86_400_000),
      0
    )
  );

export const search = Effect.fn("Remembers.search")(function* search(
  input: typeof SearchInput.Type
) {
  const query = yield* Schema.decodeEffect(SearchInput)(input).pipe(
    Effect.mapError(
      () => new Failure({ code: "search_input", operation: "search" })
    )
  );

  const store = yield* Store;
  const source = yield* SliceSource;
  const now = yield* Clock.currentTimeMillis;

  const records = [...(yield* store.search(query.text, query.project))].filter(
    (record) => record.invalid_at === null
  );

  records.sort(
    (a, b) =>
      priority(b) - priority(a) ||
      Number(b.claim.project === query.project) -
        Number(a.claim.project === query.project) ||
      salience(b, now) - salience(a, now) ||
      b.valid_from - a.valid_from
  );

  return yield* Effect.forEach((record: MemoryRecordValue) =>
    Effect.gen(function* resolveHit() {
      const quotes = yield* Effect.forEach((cite: CiteRefValue) =>
        Effect.gen(function* resolveQuote() {
          const resolved = yield* source.quote(cite).pipe(
            Effect.map((text) => ({ stale: false, text })),
            Effect.orElseSucceed((error) => ({
              stale: error.code === "cite_stale",
              text: null,
            }))
          );

          const { text } = resolved;

          if (resolved.stale) {
            return { status: "stale", text: null } as const;
          }

          if (text === null) {
            return { status: "unavailable", text: null } as const;
          }

          if ((yield* sha256(text)) !== cite.sha256) {
            return { status: "stale", text: null } as const;
          }

          return safeEvidenceQuote(text)
            ? ({ status: "verified", text } as const)
            : ({ status: "unavailable", text: null } as const);
        })
      )(record.cites);

      return { age_ms: Math.max(0, now - record.valid_from), quotes, record };
    })
  )(records);
});

export const logUse = Effect.fn("Remembers.logUse")(function* logUse(
  project: string,
  id: string,
  useId: string
) {
  const store = yield* Store;
  yield* store.use(project, id, useId, yield* Clock.currentTimeMillis);
});

export const cli = Effect.fn("Remembers.cli")(function* cli(
  args: readonly string[]
) {
  const [command, text, flag, project] = args;

  if (command === "--help" || command === "help") {
    return recallHelp;
  }

  if (
    command !== "search" ||
    text === undefined ||
    text.length === 0 ||
    args.length > 4 ||
    (flag !== undefined && flag !== "--project") ||
    (flag === "--project" && (project === undefined || project.length === 0))
  ) {
    return yield* new Failure({
      code: "usage_search_text_project",
      operation: "cli",
    });
  }

  return JSON.stringify(yield* search({ project: project ?? null, text }));
});
