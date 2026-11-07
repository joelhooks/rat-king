import { ByteSize, Effect, FileSystem, Schema } from "effect";

import { AlarmJournal, emptyJournal } from "./alarm.ts";
import type { AlarmJournalValue } from "./alarm.ts";
import { FleetError } from "./stage-config.ts";

export const alarmJournalCap = 32 * 1024 * 1024;

export const alarmJournalChunk = 64 * 1024;

const invalidJournal = () =>
  new FleetError({
    reason: "Invalid alarm journal; refused to forget prior notifications",
  });

const privateJournalSize = Effect.fn("Alarm.privateJournalSize")(
  function* privateJournalSize(file: string) {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(file))) {
      return 0n;
    }

    const info = yield* fs.stat(file);

    if ((yield* fs.realPath(file)) !== file || info.mode % 0o1000 !== 0o600) {
      return yield* new FleetError({
        reason: "Alarm journal is not a private owned file",
      });
    }

    return ByteSize.toBigInt(info.size);
  }
);

const recordEnd = (bytes: Uint8Array, length: number) => {
  let end = length;

  while (end > 0 && [9, 10, 13, 32].includes(bytes[end - 1] ?? -1)) {
    end -= 1;
  }

  return end;
};

const readLastRecord = Effect.fn("Alarm.readLastRecord")(
  function* readLastRecord(file: string, size: bigint) {
    const fs = yield* FileSystem.FileSystem;
    const handle = yield* fs.open(file, { flag: "r" });
    const parts: Uint8Array[] = [];
    let position = size;
    let length = 0;

    while (position > 0n) {
      const count = Number(
        position < BigInt(alarmJournalChunk)
          ? position
          : BigInt(alarmJournalChunk)
      );

      position -= BigInt(count);
      yield* handle.seek(position, "start");
      const bytes = new Uint8Array(count);
      let read = 0;

      while (read < count) {
        const received = yield* handle.read(bytes.subarray(read));

        if (received === 0) {
          return yield* invalidJournal();
        }

        read += received;
      }

      const end = length === 0 ? recordEnd(bytes, count) : count;
      const start = bytes.subarray(0, end).lastIndexOf(10) + 1;
      const part = bytes.slice(start, end);
      length += part.length;

      if (length > alarmJournalCap) {
        return yield* invalidJournal();
      }

      if (part.length > 0) {
        parts.push(part);
      }

      if (start > 0) {
        break;
      }
    }

    const record = new Uint8Array(length);
    let offset = 0;

    for (const part of parts.toReversed()) {
      record.set(part, offset);
      offset += part.length;
    }

    const text = yield* Effect.try({
      catch: invalidJournal,
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
          .decode(record)
          .trim(),
    });

    if (length > 0 && text === "") {
      return yield* invalidJournal();
    }

    return text;
  },
  Effect.scoped
);

export const readAlarmJournal = Effect.fn("Alarm.readJournal")(
  function* readAlarmJournal(directory: string) {
    const file = `${directory}/alarms.jsonl`;
    const size = yield* privateJournalSize(file);

    if (size === 0n) {
      return emptyJournal;
    }

    const last = yield* readLastRecord(file, size);

    if (last === "") {
      return emptyJournal;
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(AlarmJournal))(
      last
    ).pipe(Effect.mapError(invalidJournal));
  }
);

export const saveAlarmJournal = Effect.fn("Alarm.saveJournal")(
  function* saveAlarmJournal(directory: string, state: AlarmJournalValue) {
    const fs = yield* FileSystem.FileSystem;
    const journal = `${directory}/alarms.jsonl`;
    const size = yield* privateJournalSize(journal);

    const next = yield* Schema.encodeEffect(
      Schema.fromJsonString(AlarmJournal)
    )(state);

    const bytes = new TextEncoder().encode(`${next}\n`);

    if (bytes.length > alarmJournalCap) {
      return yield* new FleetError({
        reason:
          "Alarm journal state exceeds size cap; prior notifications retained",
      });
    }

    if (size + BigInt(bytes.length) > BigInt(alarmJournalCap)) {
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory,
        prefix: ".alarm-journal-",
      });

      const file = `${temporary}/latest`;
      const handle = yield* fs.open(file, { flag: "wx", mode: 0o600 });
      yield* handle.writeAll(bytes);
      yield* handle.sync;
      yield* fs.rename(file, journal);
    } else {
      const handle = yield* fs.open(journal, { flag: "a", mode: 0o600 });
      yield* handle.writeAll(bytes);
      yield* handle.sync;
    }

    return yield* Effect.void;
  },
  Effect.scoped
);
