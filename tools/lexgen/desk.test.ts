// @effect-diagnostics nodeBuiltinImport:off -- Public fixture parity uses exact JSON files.
import { readFileSync } from "node:fs";

import { Lexicons, parseLexiconDoc } from "@atproto/lexicon";
import { expect, it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";

import * as Answer from "../../packages/lexicon/src/desk.answer.ts";
import * as Item from "../../packages/lexicon/src/desk.item.ts";
import * as Update from "../../packages/lexicon/src/desk.update.ts";

const json = (path: string) =>
  Schema.decodeUnknownSync(Schema.Json)(
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf-8"))
  );

const validators = new Lexicons(
  ["item", "answer", "update"].map((name) =>
    parseLexiconDoc(json(`../../lexicons/sh/mschf/ratking/desk/${name}.json`))
  )
);

for (const [name, codec] of [
  ["item", Item.Main],
  ["update", Update.Main],
] as const) {
  it(`desk ${name} shared fixture round-trips through both codecs`, () => {
    const raw = json(`../../packages/lexicon/test/fixtures/desk-${name}.json`);
    const decoded = Schema.decodeUnknownSync(codec)(raw);
    const encoded = Schema.encodeSync(codec)(decoded);
    expect(encoded).toEqual(raw);
    expect(
      validators.assertValidRecord(`sh.mschf.ratking.desk.${name}`, encoded)
    ).toEqual(raw);
  });
}

const Feedback = Schema.Struct({
  itemId: Schema.String,
  note: Schema.String,
  project: Schema.String,
  rows: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  values: Schema.Record(Schema.String, Schema.String),
});

it.prop(
  "desk feedback preserves arbitrary axis maps, row maps and notes both ways",
  [Arbitrary.schema(Feedback)],
  ([feedback]) => {
    const raw = {
      $type: "sh.mschf.ratking.desk.answer",
      inReplyTo: "3m5abcde23456",
      ...feedback,
    };

    const encoded = Schema.encodeSync(Answer.Main)(
      Schema.decodeUnknownSync(Answer.Main)(raw)
    );

    expect(encoded).toEqual(raw);
    expect(validators.assertValidRecord(raw.$type, encoded)).toEqual(raw);
  }
);
