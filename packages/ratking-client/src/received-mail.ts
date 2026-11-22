import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { ReplyRef } from "../../mailbox-client/src/payload.ts";
import { writePrivateJson } from "./directory.ts";
import { withLock } from "./lock.ts";
import { provisionLabel } from "./name.ts";
import { Kind, LexiconRecord } from "./payload.ts";

const mailFields = {
  did: Schema.String,
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
      body: Schema.String,
      cc: Schema.Boolean,
      ccNames: Schema.optionalKey(Schema.Array(Schema.String)),
      kind: Kind,
      label: Schema.OptionFromNullOr(Schema.String),
      reply: Schema.optionalKey(ReplyRef),
      summary: Schema.OptionFromNullOr(Schema.String),
      thread: Schema.optionalKey(Schema.String),
      to: Schema.optionalKey(Schema.String),
    }),
  ]),
  redelivered: Schema.optionalKey(Schema.Boolean),
  seq: Schema.optionalKey(Schema.Int),
});

export type ReceivedMail = typeof ReceivedEntry.Type;

const RECEIVED_MAIL_LIMIT = 64;

const Journal = Schema.fromJsonString(Schema.Array(ReceivedEntry));

export const receivedMail = (state: string, name: string) =>
  Effect.gen(function* openReceivedMail() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const key = provisionLabel(name);
    const file = path.join(state, "received-mail", `${key}.json`);

    const load = fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeEffect(Journal)),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<readonly ReceivedMail[]>([])
      )
    );

    const transact = (entry?: ReceivedMail) =>
      withLock(
        path.join(state, "locks"),
        `${key}-received`,
        Effect.gen(function* updateReceivedMail() {
          const entries = yield* load;
          const safe = entries.filter((other) => other.encrypted === false);

          const next =
            entry?.encrypted === false
              ? [
                  ...safe
                    .filter((other) => other.received.id !== entry.received.id)
                    .slice(1 - RECEIVED_MAIL_LIMIT),
                  entry,
                ]
              : safe;

          if (entry?.encrypted === false || safe.length !== entries.length) {
            const json = yield* Schema.encodeEffect(Journal)(next, {
              onExcessProperty: "ignore",
            });

            yield* writePrivateJson(file, json);
          }

          return next;
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
              entries.find((entry) => entry.received.id === id)
            )
          )
        ),
      save: (entry: ReceivedMail) => transact(entry).pipe(Effect.asVoid),
    };
  });
