import { Config, Effect, FileSystem, Option, Schema } from "effect";

import { digest } from "../../packages/alchemy-nest/src/files.ts";
import { ShipCheckpoint } from "./ship-config.ts";

export const shippedDrift = <E, R>(
  read: Effect.Effect<Option.Option<string>, E, R>
) =>
  read.pipe(
    Effect.map((started) =>
      read.pipe(
        Effect.map(
          (now) =>
            Option.isSome(started) &&
            Option.isSome(now) &&
            now.value !== started.value
        )
      )
    )
  );

export const runtimeDrift = Effect.gen(function* captureRuntime() {
  const entry = yield* Config.String("RAT_KING_SHIP_RUNTIME_ENTRY").pipe(
    Config.withDefault(`${import.meta.dirname}/cli.ts`)
  );

  const fs = yield* FileSystem.FileSystem;

  const fingerprint = Effect.gen(function* installedFingerprint() {
    const file = yield* fs.realPath(entry);
    const stat = yield* fs.stat(file);
    const bytes = yield* fs.readFile(file);

    return `${file}:${Option.getOrUndefined(stat.ino)}:${digest(bytes)}`;
  });

  const started = yield* fingerprint;

  return {
    drifted: fingerprint.pipe(
      Effect.map((current) => current !== started),
      Effect.orElseSucceed(() => true)
    ),
  };
});

export const readShippedSha = (checkpoint: string | undefined) =>
  Effect.gen(function* shipped() {
    if (checkpoint === undefined) {
      return Option.none<string>();
    }

    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(checkpoint))) {
      return Option.none<string>();
    }

    const saved = yield* Schema.decodeEffect(
      Schema.fromJsonString(ShipCheckpoint)
    )(yield* fs.readFileString(checkpoint));

    return saved.successful === ""
      ? Option.none<string>()
      : Option.some<string>(saved.successful);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
