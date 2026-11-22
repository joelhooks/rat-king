import type { Path } from "effect";
import { Effect, FileSystem, Schema } from "effect";

import { readBoundedRegularFile } from "../../packages/alchemy-nest/src/files.ts";
import { writePrivateJson } from "../../packages/ratking-client/src/directory.ts";
import { FleetError } from "./stage-config.ts";

const maxCharges = 39;

export const githubBudget =
  (charges: number[] = []) =>
  (now: number): boolean => {
    while ((charges[0] ?? Infinity) <= now - 3_600_000) {
      charges.shift();
    }

    if (charges.length >= maxCharges) {
      return false;
    }

    const at = Math.max(charges.at(-1) ?? now, now);
    charges.push(at);

    return true;
  };

export interface GithubBudget {
  readonly charge: ReturnType<typeof githubBudget>;
  readonly save: Effect.Effect<void, FleetError>;
}

const Ledger = Schema.fromJsonString(
  Schema.Array(Schema.Int).check(Schema.isMaxLength(maxCharges))
);

const ledgerError = () => new FleetError({ reason: "GitHubBudgetUnavailable" });

export const durableGithubBudget = Effect.fn("Ship.githubBudget")(
  function* durableGithubBudget(path: string) {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const fs = yield* FileSystem.FileSystem;

    const charges = (yield* fs.exists(path))
      ? (yield* readBoundedRegularFile(path, 2048).pipe(
          Effect.map((bytes) => new TextDecoder().decode(bytes)),
          Effect.flatMap(Schema.decodeEffect(Ledger))
        )).toSorted((a, b) => a - b)
      : [];

    return {
      charge: githubBudget(charges),
      save: Effect.suspend(() =>
        writePrivateJson(path, JSON.stringify(charges))
      ).pipe(Effect.provide(services), Effect.mapError(ledgerError)),
    } satisfies GithubBudget;
  },
  Effect.mapError(ledgerError)
);
