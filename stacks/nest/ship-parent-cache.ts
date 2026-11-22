import type { Path } from "effect";
import { Effect, FileSystem, Schema } from "effect";

import { readBoundedRegularFile } from "../../packages/alchemy-nest/src/files.ts";
import { writePrivateJson } from "../../packages/ratking-client/src/directory.ts";
import { Sha } from "./ship-config.ts";
import { maxFirstParents } from "./ship-select.ts";
import { FleetError } from "./stage-config.ts";

const maximum = maxFirstParents * 2;

const ParentRows = Schema.fromJsonString(
  Schema.Array(Schema.Tuple([Sha, Schema.NullOr(Sha)])).check(
    Schema.isMaxLength(maximum)
  )
);

const parentError = () =>
  new FleetError({ reason: "GitHubParentCacheUnavailable" });

export const parentCache = (
  seed: readonly (readonly [string, string | null])[] = []
) => new Map(seed.map(([sha, parent]) => [sha, parent ?? undefined]));

export interface ParentCache {
  readonly parents: ReturnType<typeof parentCache>;
  readonly save: Effect.Effect<void, FleetError>;
}

export const durableParentCache = Effect.fn("Ship.durableParents")(
  function* durableParents(path: string) {
    const fs = yield* FileSystem.FileSystem;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const entries = (yield* fs.exists(path))
      ? yield* readBoundedRegularFile(path, 64 * 1024).pipe(
          Effect.map((bytes) => new TextDecoder().decode(bytes)),
          Effect.flatMap(Schema.decodeEffect(ParentRows))
        )
      : [];

    const parents = parentCache(entries);

    return {
      parents,
      save: Effect.suspend(() =>
        writePrivateJson(path, JSON.stringify([...parents]))
      ).pipe(Effect.provide(services), Effect.mapError(parentError)),
    } satisfies ParentCache;
  },
  Effect.mapError(parentError)
);
