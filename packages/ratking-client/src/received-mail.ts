import { Clock, Data, Effect, FileSystem, Option, Path, Schema } from "effect";

import { ReplyRef } from "../../mailbox-client/src/payload.ts";
import { writePrivateJson } from "./directory.ts";
import { withLock } from "./lock.ts";
import { provisionLabel } from "./name.ts";
import { Kind, LexiconRecord, PassSource, RelaySource } from "./payload.ts";

const mailFields = {
  did: Schema.String,
  encrypted: Schema.optionalKey(Schema.Boolean),
  expiresAt: Schema.optionalKey(Schema.String),
  from: Schema.String,
  id: Schema.String,
  replyTo: Schema.OptionFromNullOr(Schema.String),
  verified: Schema.Boolean,
};

const ReceivedEntry = Schema.Struct({
  encrypted: Schema.optionalKey(Schema.Boolean),
  received: Schema.Union([
    Schema.Struct({ ...mailFields, record: LexiconRecord }),
    Schema.Struct({
      ...mailFields,
      askSummary: Schema.optionalKey(Schema.String),
      body: Schema.String,
      cc: Schema.Boolean,
      ccNames: Schema.optionalKey(Schema.Array(Schema.String)),
      copy: Schema.optionalKey(Schema.Boolean),
      delegatedFor: Schema.optionalKey(Schema.String),
      delegatedTo: Schema.optionalKey(Schema.String),
      digestMinutes: Schema.optionalKey(Schema.Finite),
      kind: Kind,
      label: Schema.OptionFromNullOr(Schema.String),
      noReply: Schema.optionalKey(Schema.Boolean),
      originalId: Schema.optionalKey(Schema.String),
      quiet: Schema.optionalKey(Schema.Boolean),
      relay: Schema.optionalKey(RelaySource),
      reply: Schema.optionalKey(ReplyRef),
      routedCopy: Schema.optionalKey(Schema.Boolean),
      routedWake: Schema.optionalKey(Schema.Boolean),
      sender: Schema.optionalKey(Schema.String),
      sentBy: Schema.optionalKey(Schema.String),
      summary: Schema.OptionFromNullOr(Schema.String),
      thread: Schema.optionalKey(Schema.String),
      threadRouter: Schema.optionalKey(RelaySource),
      to: Schema.optionalKey(Schema.String),
      via: Schema.optionalKey(PassSource),
    }),
  ]),
  redelivered: Schema.optionalKey(Schema.Boolean),
  seq: Schema.optionalKey(Schema.Int),
});

export type ReceivedMail = typeof ReceivedEntry.Type;

export const RECEIVED_MAIL_BYTES = 256 * 1024;

export const RECEIVED_MAIL_TTL_MS = 24 * 60 * 60 * 1000;

const RECEIVED_MAIL_LIMIT = 64;

class JournalTooLarge extends Data.TaggedError("JournalTooLarge") {}

const Stored = Schema.Struct({ entry: ReceivedEntry, savedAt: Schema.Int });

const Journal = Schema.fromJsonString(Schema.Array(Stored));

const encode = Schema.encodeEffect(Schema.fromJsonString(Stored), {
  onExcessProperty: "error",
});

const utf8 = new TextEncoder();

const keepNewest = (encoded: readonly string[]) => {
  const kept: string[] = [];
  let size = 2;

  for (const json of encoded.toReversed()) {
    size += utf8.encode(json).length + (kept.length === 0 ? 0 : 1);

    if (size > RECEIVED_MAIL_BYTES) {
      break;
    }

    kept.push(json);
  }

  return kept.length === 0 && encoded.length > 0
    ? Effect.fail(new JournalTooLarge())
    : Effect.succeed(`[${kept.toReversed().join(",")}]`);
};

export const receivedMail = (state: string, name: string) =>
  Effect.gen(function* openReceivedMail() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const key = provisionLabel(name);
    const file = path.join(state, "received-mail", `${key}.json`);

    const load = Effect.gen(function* readBoundedJournal() {
      const { size } = yield* fs.stat(file);

      if (size > RECEIVED_MAIL_BYTES) {
        return yield* new JournalTooLarge();
      }

      return yield* fs.readFileString(file);
    }).pipe(
      Effect.flatMap(Schema.decodeEffect(Journal)),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<readonly (typeof Stored.Type)[]>([])
      )
    );

    const transact = (entry?: ReceivedMail) =>
      withLock(
        path.join(state, "locks"),
        `${key}-received`,
        Effect.gen(function* updateReceivedMail() {
          const entries = yield* load;
          const now = yield* Clock.currentTimeMillis;

          const safe = entries.filter(
            (other) =>
              other.entry.encrypted === false &&
              now - other.savedAt < RECEIVED_MAIL_TTL_MS
          );

          if (entry?.encrypted === false || safe.length !== entries.length) {
            const next =
              entry?.encrypted === false
                ? [
                    ...safe
                      .filter(
                        (other) => other.entry.received.id !== entry.received.id
                      )
                      .slice(1 - RECEIVED_MAIL_LIMIT),
                    { entry, savedAt: now },
                  ]
                : safe;

            const encoded = yield* Effect.forEach((item: typeof Stored.Type) =>
              encode(item)
            )(next);

            const json = yield* keepNewest(encoded);
            yield* writePrivateJson(file, json);
          }

          return safe;
        })
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path)
      );

    return {
      find: (id: string) =>
        transact().pipe(
          Effect.map((entries) =>
            Option.fromNullishOr(
              entries.find(({ entry }) => entry.received.id === id)?.entry
            )
          )
        ),
      save: (entry: ReceivedMail) => transact(entry).pipe(Effect.asVoid),
    };
  });
