import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Exit, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { readAlarmJournal } from "../../../stacks/nest/alarm-command.ts";
import { AlarmJournal, emptyJournal } from "../../../stacks/nest/alarm.ts";

const Journal = Arbitrary.schema(
  Schema.Struct({
    ...AlarmJournal.fields,
    pending: Schema.Array(Schema.Never),
    wakeOnMail: Schema.optionalKey(
      Schema.Struct({
        ...AlarmJournal.fields.wakeOnMail.schema.fields,
        pending: Schema.Record(Schema.String, Schema.Never),
      })
    ),
  })
);

const options = { arbitrary: { runs: 30 } };

it.effect.prop(
  "restart restores the last complete alarm journal, not an earlier notification state",
  [Journal, Journal],
  ([prior, latest]) =>
    Effect.gen(function* restore() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

      const before = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(prior);

      const after = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(latest);

      yield* fs.writeFileString(
        `${directory}/alarms.jsonl`,
        `${before}\n${after}\n`,
        { mode: 0o600 }
      );
      expect(yield* readAlarmJournal(directory)).toEqual(JSON.parse(after));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  options
);

it.effect.prop(
  "a corrupt last journal record fails closed instead of replaying stale notification state",
  [Journal, Arbitrary.schema(Schema.String)],
  ([prior, suffix]) =>
    Effect.gen(function* corrupt() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

      const before = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(prior);

      yield* fs.writeFileString(
        `${directory}/alarms.jsonl`,
        `${before}\n!${suffix}`,
        { mode: 0o600 }
      );
      const error = yield* readAlarmJournal(directory).pipe(Effect.flip);
      expect(error).toMatchObject({
        reason: "Invalid alarm journal; refused to forget prior notifications",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  options
);

it.effect.prop(
  "only an absent journal or an owned private journal can restore notification state",
  [
    Arbitrary.schema(
      Schema.Struct({
        exists: Schema.Boolean,
        mode: Schema.Literals([0o600, 0o644, 0o400, 0o700]),
        redirected: Schema.Boolean,
      })
    ),
  ],
  ([input]) =>
    Effect.gen(function* ownership() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const file = `${directory}/alarms.jsonl`;

      if (input.exists) {
        const target = input.redirected ? `${directory}/target` : file;
        yield* fs.writeFileString(target, "\n", { mode: 0o600 });
        yield* fs.chmod(target, input.mode);

        if (input.redirected) {
          yield* fs.symlink(target, file);
        }
      }

      const result = yield* readAlarmJournal(directory).pipe(Effect.exit);
      const safe = !input.exists || (!input.redirected && input.mode === 0o600);
      expect(Exit.isSuccess(result)).toBe(safe);

      if (Exit.isSuccess(result)) {
        expect(result.value).toEqual(emptyJournal);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
