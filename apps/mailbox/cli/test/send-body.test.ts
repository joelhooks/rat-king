import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";

import { sendBody } from "../send-body.ts";

it.effect(
  "record sends preserve shared JSON fixtures; text remains text; ambiguous and malformed inputs fail before sending",
  () =>
    Effect.gen(function* testRecordBody() {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();

      for (const name of ["item", "answer", "update"]) {
        const record = new URL(
          `../../../../packages/lexicon/test/fixtures/desk-${name}.json`,
          import.meta.url
        ).pathname;

        const text = yield* fs.readFileString(record);
        const body = yield* sendBody({ body: undefined, record });

        expect(JSON.parse(body)).toEqual(JSON.parse(text));
      }

      expect(yield* sendBody({ body: "plain text", record: undefined })).toBe(
        "plain text"
      );

      for (const input of [
        { body: undefined, record: undefined },
        { body: "text", record: "unused.json" },
      ]) {
        expect(
          Result.isFailure(yield* sendBody(input).pipe(Effect.result))
        ).toBe(true);
      }

      const invalid = `${dir}/invalid.json`;

      for (const value of [
        "not json",
        JSON.stringify({ $type: "unknown.record" }),
        JSON.stringify({
          $type: "sh.mschf.ratking.desk.answer",
          inReplyTo: "3m5abcde23456",
          itemId: "sample",
          project: "sample",
          values: { axis: 123 },
        }),
      ]) {
        yield* fs.writeFileString(invalid, value);

        expect(
          Result.isFailure(
            yield* sendBody({ body: undefined, record: invalid }).pipe(
              Effect.result
            )
          )
        ).toBe(true);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
