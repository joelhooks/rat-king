import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { writePrivateJson } from "./directory.ts";
import { withLock } from "./lock.ts";
import { provisionLabel } from "./name.ts";
import { ReaderJournal } from "./reader-journal.ts";

export const checkpointPermitted = (
  previous: typeof ReaderJournal.Type,
  next: typeof ReaderJournal.Type
) =>
  next.generation > previous.generation ||
  (next.generation === previous.generation &&
    next.session === previous.session);

export const readerStore = (state: string, name: string) => {
  const load = Effect.gen(function* loadReaderJournal() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const file = path.join(
      state,
      "reader-journals",
      `${provisionLabel(name)}.json`
    );

    return (yield* fs.exists(file))
      ? yield* fs
          .readFileString(file)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(ReaderJournal))
            ),
            Effect.map(Option.some)
          )
      : Option.none<typeof ReaderJournal.Type>();
  });

  return {
    load,
    save: (next: typeof ReaderJournal.Type) =>
      Effect.gen(function* saveReaderJournal() {
        const path = yield* Path.Path;

        return yield* withLock(
          path.join(state, "locks"),
          `${provisionLabel(name)}-reader`,
          Effect.gen(function* checkpointReader() {
            const previous = yield* load;

            if (
              Option.isSome(previous) &&
              !checkpointPermitted(previous.value, next)
            ) {
              yield* Effect.logWarning(
                "Rat King ignored a superseded reader checkpoint",
                {
                  generation: next.generation,
                  heldGeneration: previous.value.generation,
                  name,
                }
              );

              return;
            }

            yield* writePrivateJson(
              path.join(
                state,
                "reader-journals",
                `${provisionLabel(name)}.json`
              ),
              JSON.stringify(next)
            );
          })
        );
      }),
  };
};
