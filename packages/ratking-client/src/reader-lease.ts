// @effect-diagnostics nodeBuiltinImport:off -- Node adapter for SQLite locking and cryptographic journal names and credentials.
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { NodeFileSystem } from "@effect/platform-node";
import { MailboxClientError } from "@rat-king/mailbox-client";
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect";

import { writePrivateJson } from "./directory.ts";

const key = (...parts: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const Tuple = Schema.Struct({
  generation: Schema.Int,
  leaseId: Schema.String,
});

type LeaseTuple = typeof Tuple.Type;

const Pending = Schema.TaggedStruct("Pending", {
  attempt: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  resume: Schema.optionalKey(Tuple),
});

const Saved = Schema.TaggedStruct("Saved", { tuple: Tuple });

const Journal = Schema.fromJsonString(Schema.Union([Pending, Saved]));

const notSaved = () =>
  new MailboxClientError({
    error: "MailboxUnavailable",
    reason: "Rat King reader lease checkpoint unavailable",
  });

export const lockReader = Effect.fn("RatKing.lockReader")(function* lockReader(
  directory: string,
  did: string,
  session: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, `${key(did, session)}.sqlite`);

  yield* fs
    .makeDirectory(directory, { mode: 0o700, recursive: true })
    .pipe(Effect.mapError(notSaved));

  yield* Effect.acquireRelease(
    Effect.try({
      catch: () =>
        new MailboxClientError({
          error: "LocalReaderBusy",
          reason: "Rat King local reader lock unavailable",
        }),
      try: () => {
        const database = new DatabaseSync(file, { timeout: 0 });

        try {
          database.exec("BEGIN IMMEDIATE");

          return database;
        } catch (error) {
          database.close();
          throw error;
        }
      },
    }),
    (database) =>
      Effect.sync(() => {
        database.close();
      })
  );
}, Effect.provide(NodeFileSystem.layer));

export const readerLeaseJournal = Effect.fn("RatKing.readerLeaseJournal")(
  function* journal(directory: string, did: string, session: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, `${key(did, session)}.json`);

    const read = fs.exists(file).pipe(
      Effect.flatMap((exists) =>
        exists
          ? fs
              .readFileString(file)
              .pipe(Effect.flatMap(Schema.decodeEffect(Journal)), Effect.asSome)
          : Effect.succeed(Option.none<typeof Journal.Type>())
      ),
      Effect.mapError(notSaved)
    );

    const write = (entry: typeof Journal.Type) =>
      Schema.encodeEffect(Journal)(entry).pipe(
        Effect.flatMap((json) => writePrivateJson(file, json)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(notSaved)
      );

    const begin = (resume?: LeaseTuple) =>
      Effect.suspend(() => {
        const attempt = randomBytes(16).toString("hex");

        const pending = Pending.make(
          resume === undefined ? { attempt } : { attempt, resume }
        );

        return write(pending).pipe(Effect.as(pending));
      }).pipe(Effect.uninterruptible);

    return {
      begin,
      pending: (legacy: Option.Option<LeaseTuple>) =>
        read.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => begin(Option.getOrUndefined(legacy)),
              onSome: (entry) =>
                Predicate.isTagged(entry, "Pending")
                  ? Effect.succeed(entry)
                  : begin(entry.tuple),
            })
          )
        ),
      save: ({ generation, leaseId }: LeaseTuple) =>
        write(Saved.make({ tuple: { generation, leaseId } })),
    };
  }
);
