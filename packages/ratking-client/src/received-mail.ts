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

const AckOutcome = Schema.Literals([
  "acked",
  "delegated",
  "expired",
  "settled",
]);

const ReceivedEntry = Schema.Struct({
  ackOutcome: Schema.optionalKey(AckOutcome),
  acked: Schema.optionalKey(Schema.Boolean),
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

const journalEntry = (entry: ReceivedMail): ReceivedMail => {
  const { levers: _levers, ...received } = {
    levers: undefined,
    ...entry.received,
  };

  if ("alarmCrashDid" in received) {
    Reflect.deleteProperty(received, "alarmCrashDid");
  }

  const normalized = { ...entry, received };

  for (const object of [normalized, received]) {
    for (const [key, value] of Object.entries(object)) {
      if (value === undefined) {
        Reflect.deleteProperty(object, key);
      }
    }
  }

  return normalized;
};

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
    : Effect.succeed({
        count: kept.length,
        json: `[${kept.toReversed().join(",")}]`,
      });
};

export const receivedMail = (state: string, name: string) =>
  Effect.gen(function* openReceivedMail() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const key = provisionLabel(name);
    const dir = path.join(state, "received-mail");
    const file = path.join(dir, `${key}.json`);
    const corruptPrefix = `${key}.json.corrupt-`;

    const pruneCorrupt = (now: number) =>
      fs.readDirectory(dir).pipe(
        Effect.flatMap((names) =>
          Effect.forEach(
            names.filter((filename) => {
              const stamp = filename.slice(corruptPrefix.length);

              return (
                filename.startsWith(corruptPrefix) &&
                /^\d+$/u.test(stamp) &&
                now - Number(stamp) >= RECEIVED_MAIL_TTL_MS
              );
            }),
            (filename) => fs.remove(path.join(dir, filename)),
            { discard: true }
          )
        ),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.void)
      );

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

    const transact = (
      entry?: ReceivedMail,
      ack?: { readonly id: string; readonly outcome: typeof AckOutcome.Type }
    ) =>
      withLock(
        path.join(state, "locks"),
        `${key}-received`,
        Effect.gen(function* updateReceivedMail() {
          const now = yield* Clock.currentTimeMillis;
          yield* pruneCorrupt(now);

          const recover = (error: JournalTooLarge | Schema.SchemaError) =>
            fs
              .rename(file, `${file}.corrupt-${now}`)
              .pipe(
                Effect.andThen(
                  entry === undefined
                    ? Effect.fail(error)
                    : Effect.logWarning(
                        "Rat King moved a corrupt received mail journal aside"
                      ).pipe(Effect.as([]))
                )
              );

          const entries = yield* load.pipe(
            Effect.catchTags({
              JournalTooLarge: recover,
              SchemaError: recover,
            })
          );

          const safe = entries.filter(
            (other) =>
              other.entry.encrypted === false &&
              now - other.savedAt < RECEIVED_MAIL_TTL_MS
          );

          const stamped =
            ack === undefined
              ? safe
              : safe.map((item) =>
                  item.entry.received.id === ack.id
                    ? {
                        ...item,
                        entry: {
                          ...item.entry,
                          ackOutcome: ack.outcome,
                          acked: ack.outcome === "acked",
                        },
                      }
                    : item
                );

          if (
            entry?.encrypted === false ||
            ack !== undefined ||
            safe.length !== entries.length
          ) {
            const next =
              entry?.encrypted === false
                ? [
                    ...safe
                      .filter(
                        (other) => other.entry.received.id !== entry.received.id
                      )
                      .slice(1 - RECEIVED_MAIL_LIMIT),
                    { entry: journalEntry(entry), savedAt: now },
                  ]
                : stamped;

            const encoded = yield* Effect.forEach((item: typeof Stored.Type) =>
              encode(item)
            )(next);

            const { count, json } = yield* keepNewest(encoded);
            yield* writePrivateJson(file, json);

            return next.slice(next.length - count);
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
      markOutcome: (id: string, outcome: typeof AckOutcome.Type) =>
        transact(undefined, { id, outcome }).pipe(Effect.asVoid),
      save: (entry: ReceivedMail) => transact(entry).pipe(Effect.asVoid),
      stage: (entry: ReceivedMail) => transact({ ...entry, acked: false }),
    };
  });
