import { Effect, FileSystem, Option, Path } from "effect";

import type { PreparedArgs } from "./ship-prepared-evidence.ts";
import { FleetError } from "./stage-config.ts";

const protectedMode = (mode: number) =>
  Math.floor(mode / 16) % 2 === 0 && Math.floor(mode / 2) % 2 === 0;

const verifyInput = Effect.fn("Ship.verifyInput")(
  function* verifyInput(input: string, role: "helper" | "list") {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const uid = process.getuid?.();

    const rootOrSigner = (owner: number | undefined) =>
      owner === 0 || owner === uid;

    const refused = () =>
      new FleetError({
        reason:
          role === "helper" ? "ArtifactHelperCustody" : "CandidateListCustody",
      });

    if (uid === undefined || (yield* fs.realPath(input)) !== input) {
      return yield* refused();
    }

    const file = yield* fs.lstat(input);
    const owner = Option.getOrUndefined(file.uid);

    if (
      file.type !== "File" ||
      owner === undefined ||
      !protectedMode(file.mode) ||
      (role === "helper" && !rootOrSigner(owner))
    ) {
      return yield* refused();
    }

    let directory = path.dirname(input);
    let immediate = true;

    for (;;) {
      const stat = yield* fs.lstat(directory);
      const parentOwner = Option.getOrUndefined(stat.uid);

      if (
        stat.type !== "Directory" ||
        !protectedMode(stat.mode) ||
        (role === "helper" && !rootOrSigner(parentOwner)) ||
        (role === "list" && immediate && owner !== parentOwner)
      ) {
        return yield* refused();
      }

      const parent = path.dirname(directory);

      if (parent === directory) {
        return yield* Effect.void;
      }

      directory = parent;
      immediate = false;
    }
  },
  (effect, _, role) =>
    effect.pipe(
      Effect.mapError(
        () =>
          new FleetError({
            reason:
              role === "helper"
                ? "ArtifactHelperCustody"
                : "CandidateListCustody",
          })
      )
    )
);

export const verifyPreparedInputs = ([, list, , helper]: PreparedArgs) =>
  verifyInput(helper, "helper").pipe(Effect.andThen(verifyInput(list, "list")));
