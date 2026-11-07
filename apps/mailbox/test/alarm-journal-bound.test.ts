import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ByteSize, Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import {
  alarmJournalCap,
  alarmJournalChunk,
  readAlarmJournal,
  saveAlarmJournal,
} from "../../../stacks/nest/alarm-journal.ts";
import { AlarmJournal, emptyJournal } from "../../../stacks/nest/alarm.ts";

const Journal = Schema.Struct({
  ...AlarmJournal.fields,
  pending: Schema.Array(Schema.Never),
});

const ManyLines = Schema.Int.check(
  Schema.isBetween({ maximum: 37, minimum: 33 })
);

const oversizedJournal = Effect.fn("Test.oversizedJournal")(
  function* oversizedJournal(directory: string, blocks: number, last: string) {
    const fs = yield* FileSystem.FileSystem;

    const handle = yield* fs.open(`${directory}/alarms.jsonl`, {
      flag: "wx",
      mode: 0o600,
    });

    const line = `${JSON.stringify(emptyJournal)}\n`;

    const block = new TextEncoder().encode(
      line.repeat(Math.ceil((1024 * 1024) / line.length))
    );

    for (let index = 0; index < blocks; index += 1) {
      yield* handle.writeAll(block);
    }

    yield* handle.writeAll(new TextEncoder().encode(`${last}\n`));
  },
  Effect.scoped
);

it.effect.prop(
  "large multi-line journals read only a bounded tail, including multi-chunk UTF-8 records",
  [Journal, ManyLines],
  ([state, blocks]) =>
    Effect.gen(function* boundedRead() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

      const latest = {
        ...state,
        instanceRecipients: ["🙂".repeat(alarmJournalChunk + blocks)],
      };

      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(latest);

      yield* oversizedJournal(directory, blocks, encoded);
      let bytesRead = 0;
      let largestRead = 0;

      const watched = FileSystem.FileSystem.of({
        ...fs,
        open: (file, options) =>
          fs.open(file, options).pipe(
            Effect.map((handle) => ({
              ...handle,
              read: (buffer, readOptions) => {
                largestRead = Math.max(largestRead, buffer.length);

                return handle.read(buffer, readOptions).pipe(
                  Effect.tap((count) =>
                    Effect.sync(() => {
                      bytesRead += count;
                    })
                  )
                );
              },
              readAlloc: () => Effect.die("unmeasured allocation forbidden"),
              seek: (offset, from) => handle.seek(offset, from),
            }))
          ),
        readFile: () => Effect.die("whole-file read forbidden"),
        readFileString: () => Effect.die("whole-file string read forbidden"),
      });

      expect(
        yield* readAlarmJournal(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, watched)
        )
      ).toEqual(JSON.parse(encoded));
      expect(largestRead).toBeLessThanOrEqual(alarmJournalChunk);
      expect(bytesRead).toBeLessThanOrEqual(
        new TextEncoder().encode(encoded).length + alarmJournalChunk
      );
      expect(
        ByteSize.toBigInt((yield* fs.stat(`${directory}/alarms.jsonl`)).size)
      ).toBeGreaterThan(BigInt(alarmJournalCap));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 } }
);

it.effect.prop(
  "saving an over-cap journal atomically replaces history with the same latest private state",
  [Journal, ManyLines],
  ([state, blocks]) =>
    Effect.gen(function* rotate() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const file = `${directory}/alarms.jsonl`;

      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(state);

      yield* oversizedJournal(directory, blocks, encoded);
      let renamed = false;

      const watched = FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) =>
          Effect.gen(function* atomicReplace() {
            expect(to).toBe(file);
            expect(
              yield* readAlarmJournal(directory).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.orDie
              )
            ).toEqual(JSON.parse(encoded));
            expect((yield* fs.stat(from)).mode % 0o1000).toBe(0o600);
            yield* fs.rename(from, to);
            renamed = true;
          }),
      });

      yield* saveAlarmJournal(directory, state).pipe(
        Effect.provideService(FileSystem.FileSystem, watched)
      );
      expect(renamed).toBe(true);
      expect(yield* readAlarmJournal(directory)).toEqual(JSON.parse(encoded));
      expect(ByteSize.toBigInt((yield* fs.stat(file)).size)).toBe(
        BigInt(new TextEncoder().encode(`${encoded}\n`).length)
      );
      expect((yield* fs.stat(file)).mode % 0o1000).toBe(0o600);
      expect(yield* fs.readDirectory(directory)).toEqual(["alarms.jsonl"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 } }
);

it.effect.prop(
  "a failed atomic replacement retains prior notifications and cleans its private temporary file",
  [Journal],
  ([state]) =>
    Effect.gen(function* failedRotation() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(state);

      yield* oversizedJournal(directory, 33, encoded);

      const watched = FileSystem.FileSystem.of({
        ...fs,
        rename: () => FileSystem.makeNoop({}).rename("unused", "unused"),
      });

      yield* saveAlarmJournal(directory, emptyJournal).pipe(
        Effect.provideService(FileSystem.FileSystem, watched),
        Effect.flip
      );
      expect(yield* readAlarmJournal(directory)).toEqual(JSON.parse(encoded));
      expect(yield* fs.readDirectory(directory)).toEqual(["alarms.jsonl"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 2 } }
);

it.effect.prop(
  "an oversized record is refused on read and write without discarding the journal",
  [Schema.Int.check(Schema.isBetween({ maximum: 16, minimum: 1 }))],
  ([extra]) =>
    Effect.gen(function* oversizedRecord() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const file = `${directory}/alarms.jsonl`;
      const prior = `${JSON.stringify(emptyJournal)}\n`;
      yield* fs.writeFileString(file, prior, { mode: 0o600 });
      yield* saveAlarmJournal(directory, {
        ...emptyJournal,
        instanceRecipients: ["x".repeat(alarmJournalCap + extra)],
      }).pipe(Effect.flip);
      expect(yield* fs.readFileString(file)).toBe(prior);
      yield* fs.writeFileString(file, "!".repeat(alarmJournalCap + extra));
      expect(
        yield* readAlarmJournal(directory).pipe(Effect.flip)
      ).toMatchObject({
        reason: "Invalid alarm journal; refused to forget prior notifications",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 2 } }
);
