import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
  Clock,
  Effect,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  Semaphore,
} from "effect";
import { ChildProcessSpawner } from "effect/process";

import { absent } from "./absent.ts";
import { countInProcess } from "./slice-count.ts";
import {
  ChunkMetadataSchema,
  maxSliceBytes,
  SliceChunkSchema,
  SliceError,
  SliceSource,
} from "./slice-source.ts";
import type { SliceChunk } from "./slice-source.ts";

const rangeCte = `WITH ordered AS (
  SELECT chunks.chunk_id, chunks.role, chunks.started_at, chunks.text,
    row_number() OVER (ORDER BY chunks.started_at, chunks.chunk_idx, chunks.chunk_id) AS position
  FROM chunks JOIN runs ON chunks.run_id = runs.run_id WHERE runs.conversation_id = ?
), bounds AS (
  SELECT (SELECT position FROM ordered WHERE chunk_id = ?) AS first,
         (SELECT position FROM ordered WHERE chunk_id = ?) AS last
)`;

const rangeSql = `${rangeCte} SELECT chunk_id, role, started_at, CAST(text AS BLOB) AS text FROM ordered, bounds
WHERE position BETWEEN first AND last ORDER BY position LIMIT 8193`;

const budgetSql = `${rangeCte} SELECT sum(length(CAST(text AS BLOB)) + length(CAST(role AS BLOB)) + length(CAST(chunk_id AS BLOB)) + 32) AS bytes FROM ordered, bounds WHERE position BETWEEN first AND last`;

const pageSql = `WITH window AS MATERIALIZED (
 SELECT chunks.rowid AS rowid, chunks.chunk_id, runs.conversation_id AS conversation, chunks.role, chunks.started_at, chunks.token_count
 FROM chunks JOIN runs ON chunks.run_id=runs.run_id
 WHERE chunks.rowid > ? ORDER BY chunks.rowid LIMIT ?
), activity AS MATERIALIZED (
 SELECT runs.conversation_id, max(chunks.started_at) AS latest
 FROM runs JOIN chunks ON chunks.run_id=runs.run_id
 WHERE runs.conversation_id IN (SELECT conversation FROM window)
 GROUP BY runs.conversation_id
), prefix AS (
 SELECT window.*, activity.latest FROM window JOIN activity ON activity.conversation_id=window.conversation
)
SELECT rowid, chunk_id, conversation, role, started_at, token_count FROM prefix
WHERE rowid < coalesce((SELECT min(rowid) FROM prefix WHERE latest >= ?), 9223372036854775807) ORDER BY rowid`;

const storedText = Schema.Uint8Array.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((bytes) =>
      Buffer.from(bytes).toString("utf-8")
    ),
    encode: SchemaGetter.transform((text) => Buffer.from(text, "utf-8")),
  })
);

const StoredChunk = Schema.Struct({
  ...SliceChunkSchema.fields,
  text: storedText,
});

const unavailable = () =>
  new SliceError({ reason: "Slice database unavailable.", status: 500 });

export const sqliteSliceSource = (path: string, lookbackDays: number) =>
  Layer.effect(
    SliceSource,
    Effect.gen(function* sqlite() {
      if (
        !Number.isSafeInteger(lookbackDays) ||
        lookbackDays < 1 ||
        lookbackDays > 3650
      ) {
        return yield* new SliceError({
          reason: "A bounded count lookback must be configured.",
          status: 500,
        });
      }

      const countPermit = yield* Semaphore.make(1);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const db = yield* Effect.acquireRelease(
        Effect.try({
          catch: unavailable,
          try: () => {
            const url = pathToFileURL(path);
            url.searchParams.set("mode", "ro");

            const opened = new DatabaseSync(url, {
              allowExtension: false,
              readOnly: true,
            });

            try {
              opened.exec(
                "PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000;"
              );

              return opened;
            } catch (error) {
              opened.close();
              throw error;
            }
          },
        }),
        (opened) =>
          Effect.sync(() => {
            opened.close();
          })
      );

      return SliceSource.of({
        chunks: Effect.fn("SliceSource.sqlite.chunks")(
          function* chunks(after, limit, idleMs) {
            if (
              !Number.isSafeInteger(after) ||
              after < 0 ||
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > 2000 ||
              !Number.isSafeInteger(idleMs) ||
              idleMs < 1
            ) {
              return yield* new SliceError({
                reason: "Invalid chunk cursor.",
                status: 400,
              });
            }

            const cutoff = (yield* Clock.currentTimeMillis) - idleMs;

            const rows = yield* Effect.try({
              catch: unavailable,
              try: () => db.prepare(pageSql).all(after, limit, cutoff),
            });

            const items = yield* Schema.decodeUnknownEffect(
              Schema.Array(ChunkMetadataSchema)
            )(rows).pipe(Effect.mapError(unavailable));

            return { items, next: items.at(-1)?.rowid ?? after };
          }
        ),
        count: Effect.fn("SliceSource.sqlite.count")(
          function* count(signature) {
            const { length } = Array.from(signature.literal, (point) => point);
            const now = yield* Clock.currentTimeMillis;
            const floor = now - lookbackDays * 86_400_000;

            if (
              length < 8 ||
              length > 200 ||
              !Number.isSafeInteger(signature.since_ms) ||
              signature.since_ms < floor ||
              signature.since_ms > now ||
              (signature.role !== undefined &&
                (signature.role.length < 1 || signature.role.length > 128))
            ) {
              return yield* new SliceError({
                reason: `Invalid signature; since_ms floor is ${floor}.`,
                status: 400,
              });
            }

            const result = yield* countInProcess(path, signature).pipe(
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                spawner
              ),
              countPermit.withPermitsIfAvailable(1)
            );

            return Option.isNone(result)
              ? yield* new SliceError({
                  reason: "Count query is busy.",
                  status: 429,
                })
              : result.value;
          }
        ),
        quote: Effect.fn("SliceSource.sqlite.quote")(
          function* quote(chunk, start, end) {
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start < 0 ||
              end < start ||
              end - start > 280
            ) {
              return yield* new SliceError({
                reason: "Invalid quote offsets.",
                status: 400,
              });
            }

            const row = yield* Effect.try({
              catch: unavailable,
              try: () =>
                db
                  .prepare(
                    "SELECT CAST(text AS BLOB) AS text FROM chunks WHERE chunk_id = ?"
                  )
                  .get(chunk),
            });

            if (row === undefined) {
              return yield* new SliceError({
                reason: "Chunk not found.",
                status: 404,
              });
            }

            const valid = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ text: storedText })
            )(row).pipe(Effect.mapError(unavailable));

            const points = Array.from(valid.text, (point) => point);

            if (end > points.length) {
              return yield* new SliceError({
                reason: "Quote offsets exceed chunk length.",
                status: 400,
              });
            }

            return points.slice(start, end).join("");
          }
        ),
        slice: Effect.fn("SliceSource.sqlite.slice")(
          function* slice(conversation, first, last) {
            const rows = yield* Effect.try({
              catch: unavailable,
              try: () => {
                db.exec("BEGIN");

                try {
                  const budget = db
                    .prepare(budgetSql)
                    .get(conversation, first, last);

                  if (
                    !Schema.is(
                      Schema.Struct({ bytes: Schema.NullOr(Schema.Int) })
                    )(budget)
                  ) {
                    throw unavailable();
                  }

                  if ((budget.bytes ?? 0) > maxSliceBytes) {
                    return absent;
                  }

                  return db.prepare(rangeSql).all(conversation, first, last);
                } finally {
                  db.exec("ROLLBACK");
                }
              },
            });

            if (rows === undefined) {
              return yield* new SliceError({
                reason: "Slice exceeds response limit.",
                status: 413,
              });
            }

            if (rows.length === 0) {
              return yield* new SliceError({
                reason: "Chunk range not found.",
                status: 404,
              });
            }

            if (rows.length > 8192) {
              return yield* new SliceError({
                reason: "Slice exceeds response limit.",
                status: 413,
              });
            }

            const chunks: SliceChunk[] = [];
            let bytes = 0;

            for (const row of rows) {
              const chunk = yield* Schema.decodeUnknownEffect(StoredChunk)(
                row
              ).pipe(Effect.mapError(unavailable));

              bytes += Buffer.byteLength(JSON.stringify(chunk));

              if (bytes > maxSliceBytes) {
                return yield* new SliceError({
                  reason: "Slice exceeds response limit.",
                  status: 413,
                });
              }

              chunks.push(chunk);
            }

            return chunks;
          }
        ),
      });
    })
  );
