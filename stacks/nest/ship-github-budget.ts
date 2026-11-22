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
  readonly observe?: (now: number, remaining: number, reset: number) => boolean;
  readonly save: Effect.Effect<void, FleetError>;
}

const Charges = Schema.Array(Schema.Int).check(Schema.isMaxLength(maxCharges));

const State = Schema.Struct({
  blockedUntil: Schema.Int,
  charges: Charges,
  pagedUntil: Schema.Int,
});

const Ledger = Schema.fromJsonString(Schema.Union([State, Charges]));

const ledgerError = () => new FleetError({ reason: "GitHubBudgetUnavailable" });

export const durableGithubBudget = Effect.fn("Ship.githubBudget")(
  function* durableGithubBudget(path: string) {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const fs = yield* FileSystem.FileSystem;

    const saved = (yield* fs.exists(path))
      ? yield* readBoundedRegularFile(path, 2048).pipe(
          Effect.map((bytes) => new TextDecoder().decode(bytes)),
          Effect.flatMap(Schema.decodeEffect(Ledger))
        )
      : [];

    const decoded = Schema.is(State)(saved)
      ? saved
      : { blockedUntil: 0, charges: saved, pagedUntil: 0 };

    const charges = decoded.charges.toSorted((a, b) => a - b);
    const reserve = githubBudget(charges);
    let { blockedUntil, pagedUntil } = decoded;

    return {
      charge: (now: number) => now >= blockedUntil && reserve(now),
      observe: (now: number, remaining: number, reset: number) => {
        if (!Number.isSafeInteger(remaining) || remaining > 3) {
          return false;
        }

        const until =
          Number.isSafeInteger(reset) && reset > now
            ? Math.min(reset, now + 3_600_000)
            : now + 300_000;

        if (until <= blockedUntil) {
          return false;
        }

        blockedUntil = until;

        return true;
      },
      ratePage: (now: number) => {
        if (now < pagedUntil) {
          return false;
        }

        pagedUntil = blockedUntil > now ? blockedUntil : now + 3_600_000;

        return true;
      },
      save: Effect.suspend(() =>
        writePrivateJson(
          path,
          JSON.stringify({ blockedUntil, charges, pagedUntil })
        )
      ).pipe(Effect.provide(services), Effect.mapError(ledgerError)),
    };
  },
  Effect.mapError(ledgerError)
);
