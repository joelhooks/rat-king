import * as Answer from "@rat-king/lexicon/desk.answer";
import * as Item from "@rat-king/lexicon/desk.item";
import * as Update from "@rat-king/lexicon/desk.update";
import { Effect, FileSystem, Schema } from "effect";

import { CliError } from "./identity.ts";

const DeskRecord = Schema.Union([Item.Main, Answer.Main, Update.Main]);

export const sendBody = Effect.fn("MailboxCli.sendBody")(function* sendBody({
  body,
  record,
}: {
  readonly body: string | undefined;
  readonly record: string | undefined;
}) {
  if ((body === undefined) === (record === undefined)) {
    return yield* new CliError({
      reason: "Supply exactly one of --body or --record",
    });
  }

  if (record === undefined) {
    return body ?? "";
  }

  const fs = yield* FileSystem.FileSystem;

  const value = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(DeskRecord)
  )(yield* fs.readFileString(record)).pipe(
    Effect.mapError(() => new CliError({ reason: "Invalid desk JSON record" }))
  );

  if (value.$type === "sh.mschf.ratking.desk.answer") {
    yield* Schema.decodeUnknownEffect(
      Schema.Record(Schema.String, Schema.String)
    )(value.values);

    if (value.rows !== undefined) {
      yield* Schema.decodeUnknownEffect(
        Schema.Record(Schema.String, Schema.Array(Schema.String))
      )(value.rows);
    }
  }

  return JSON.stringify(yield* Schema.encodeEffect(DeskRecord)(value));
});
