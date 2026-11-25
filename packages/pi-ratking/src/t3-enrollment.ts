import { AgentName } from "@rat-king/ratking-client/name";
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";

export const T3_NOT_ENROLLED =
  "thread not enrolled; ask the owning desk to enrol it";

const ThreadId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,239}$/u)
);

const Enrollment = Schema.fromJsonString(
  Schema.Struct({
    enrolledAt: Schema.NonEmptyString,
    lane: Schema.NonEmptyString,
    name: AgentName.check(Schema.isPattern(/\//u)),
    project: Schema.NonEmptyString,
    row: Schema.NonEmptyString,
  })
);

// oxlint-disable-next-line eslint/no-bitwise -- Check Unix group/other permission bits.
const privateMode = (mode: number) => (mode & 0o077) === 0;

export const enrolledName = (id: string) =>
  Effect.gen(function* readEnrollment() {
    if (!Schema.is(ThreadId)(id)) {
      return Option.none<string>();
    }

    const home = yield* Config.String("HOME");
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const directory = path.join(home, ".local/state/rats-nest/t3-seats");
    const file = path.join(directory, `${id}.json`);
    const folder = yield* fs.lstat(directory);
    const record = yield* fs.lstat(file);

    if (
      folder.type !== "Directory" ||
      record.type !== "File" ||
      !privateMode(folder.mode) ||
      !privateMode(record.mode)
    ) {
      return Option.none<string>();
    }

    const enrollment = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeEffect(Enrollment)));

    return Option.some(enrollment.name);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
