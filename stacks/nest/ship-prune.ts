import {
  Clock,
  Console,
  Effect,
  FileSystem,
  Option,
  Random,
  Ref,
  Schema,
} from "effect";
import type { Fiber } from "effect";

import { ShipReceipt } from "./ship-config.ts";
import type { ShipSettingsValue } from "./ship-config.ts";
import { FleetError } from "./stage-config.ts";

export type EntryKind = "directory" | "file" | "other";

export interface ReleaseEntry {
  readonly kind: EntryKind;
  readonly mtime: number;
  readonly name: string;
}

export type ReleaseReceipt = Pick<typeof ShipReceipt.Type, "result" | "sha">;

export interface ReleaseCurrent {
  readonly attempt: string;
  readonly sha: string;
}

export interface RetentionPlan {
  readonly remove: readonly string[];
  readonly unknown: readonly string[];
}

export interface PruneSettings {
  readonly keep: number;
  readonly receipts: string;
  readonly releases: string;
}

const defaultKeep = 3;

const maximumKeep = 20;

const minimumKeep = 2;

const logsKept = 20;

const attemptName = /^attempt-[A-Za-z0-9]{6}$/u;

const logName = /^(?<sha>[0-9a-f]{40})\.install\.log$/u;

const releaseName = /^[0-9a-f]{40}$/u;

const trashName = /^\.trash-\d+-[a-z0-9]+$/u;

const indexMarker = ".metadata_never_index";

export const clampKeep = (value: number | undefined) =>
  Math.min(maximumKeep, Math.max(minimumKeep, value ?? defaultKeep));

type Role = "attempt" | "ignored" | "log" | "release" | "unknown";

interface Classified {
  readonly entry: ReleaseEntry;
  readonly role: Role;
  readonly sha: string;
}

const classify = (entry: ReleaseEntry): Classified => {
  const { kind, name } = entry;

  if (name === indexMarker || trashName.test(name)) {
    return { entry, role: "ignored", sha: "" };
  }

  if (kind === "directory" && releaseName.test(name)) {
    return { entry, role: "release", sha: name };
  }

  if (kind === "directory" && attemptName.test(name)) {
    return { entry, role: "attempt", sha: "" };
  }

  const log = kind === "file" ? logName.exec(name)?.groups?.sha : undefined;

  return log === undefined
    ? { entry, role: "unknown", sha: "" }
    : { entry, role: "log", sha: log };
};

const successes = (receipts: readonly ReleaseReceipt[]) =>
  receipts.filter((receipt) => receipt.result === "success");

export const pinnedShas = (
  receipts: readonly ReleaseReceipt[],
  current: ReleaseCurrent
) => {
  const shas = successes(receipts).map((receipt) => receipt.sha);
  const deployed = shas.at(-1) ?? "";
  const previous = shas.findLast((sha) => sha !== deployed) ?? "";

  return new Set([deployed, previous, current.sha].filter((sha) => sha !== ""));
};

const newestShas = (
  classified: readonly Classified[],
  receipts: readonly ReleaseReceipt[]
) => {
  const mtimes = new Map<string, number>();

  for (const { entry, sha } of classified) {
    if (sha !== "") {
      mtimes.set(sha, Math.max(mtimes.get(sha) ?? 0, entry.mtime));
    }
  }

  const seen = new Map(receipts.map((receipt, index) => [receipt.sha, index]));

  return [...mtimes.entries()]
    .toSorted(
      ([a, aTime], [b, bTime]) =>
        (seen.get(b) ?? -1) - (seen.get(a) ?? -1) ||
        bTime - aTime ||
        a.localeCompare(b)
    )
    .map(([sha]) => sha);
};

export const planRetention = (
  entries: readonly ReleaseEntry[],
  receipts: readonly ReleaseReceipt[],
  current: ReleaseCurrent,
  keep: number
): RetentionPlan => {
  const classified = entries.map(classify);
  const pinned = pinnedShas(receipts, current);
  const newest = newestShas(classified, receipts);

  const releaseKept = new Set([
    ...pinned,
    ...newest
      .filter(
        (sha) =>
          !pinned.has(sha) &&
          classified.some((item) => item.role === "release" && item.sha === sha)
      )
      .slice(0, clampKeep(keep)),
  ]);

  const logKept = new Set([...pinned, ...newest.slice(0, logsKept)]);

  const keepEntry = ({ entry, role, sha }: Classified) => {
    if (role === "release") {
      return releaseKept.has(sha);
    }

    if (role === "log") {
      return logKept.has(sha);
    }

    return role === "attempt" && entry.name === current.attempt;
  };

  return {
    remove: classified.flatMap((item) =>
      item.role === "ignored" || item.role === "unknown" || keepEntry(item)
        ? []
        : [item.entry.name]
    ),
    unknown: classified.flatMap((item) =>
      item.role === "unknown" ? [item.entry.name] : []
    ),
  };
};

const kindOf = (type: string): EntryKind => {
  if (type === "Directory") {
    return "directory";
  }

  return type === "File" ? "file" : "other";
};

const entryOf = Effect.fn("Ship.entryOf")(function* entryOf(
  releases: string,
  name: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = `${releases}/${name}`;
  const link = yield* fs.readLink(path).pipe(Effect.option);

  if (Option.isSome(link)) {
    return { kind: "other", mtime: 0, name } satisfies ReleaseEntry;
  }

  const info = yield* fs.stat(path);

  const kind: EntryKind = kindOf(info.type);

  return {
    kind,
    mtime: Option.match(info.mtime, {
      onNone: () => 0,
      onSome: (date) => date.getTime(),
    }),
    name,
  } satisfies ReleaseEntry;
});

const listEntries = Effect.fn("Ship.listEntries")(function* listEntries(
  releases: string
) {
  const fs = yield* FileSystem.FileSystem;

  const names = yield* fs.readDirectory(releases);

  return yield* Effect.all(names.map((name) => entryOf(releases, name)));
});

const readReceipts = Effect.fn("Ship.readReceipts")(function* readReceipts(
  path: string
) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(path))) {
    return [];
  }

  return (yield* fs.readFileString(path))
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) =>
      Option.toArray(
        Schema.decodeOption(Schema.fromJsonString(ShipReceipt))(line)
      )
    );
});

const sweepTrash = Effect.fn("Ship.sweepTrash")(function* sweepTrash(
  releases: string
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* listEntries(releases);

  yield* Effect.forEach(
    entries.filter(
      (entry) => trashName.test(entry.name) && entry.kind !== "other"
    ),
    (entry) =>
      fs.remove(`${releases}/${entry.name}`, { force: true, recursive: true })
  );
});

const failed = Effect.catchCause(() => Console.error("SHIP_PRUNE_FAILED"));

export const pruneReleases = Effect.fn("Ship.prune")(function* pruneReleases(
  settings: PruneSettings,
  current: ReleaseCurrent,
  logged: Ref.Ref<ReadonlySet<string>>
) {
  const fs = yield* FileSystem.FileSystem;
  const { releases } = settings;

  const plan = planRetention(
    yield* listEntries(releases),
    yield* readReceipts(settings.receipts),
    current,
    settings.keep
  );

  const before = yield* Ref.get(logged);
  const fresh = plan.unknown.filter((name) => !before.has(name));
  yield* Ref.set(logged, new Set([...before, ...plan.unknown]));

  yield* Effect.all(
    fresh.map((name) =>
      Console.error(`SHIP_PRUNE_UNKNOWN_ENTRY ${JSON.stringify(name)}`)
    )
  );

  const epoch = yield* Clock.currentTimeMillis;

  yield* Effect.all(
    plan.remove.map((name) =>
      Random.nextIntBetween(0, 2_147_483_647).pipe(
        Effect.flatMap((random) =>
          fs.rename(
            `${releases}/${name}`,
            `${releases}/.trash-${epoch}-${random.toString(36)}`
          )
        )
      )
    )
  );

  return yield* Effect.forkDetach(sweepTrash(releases).pipe(failed));
});

export const pruneSafely = (
  settings: PruneSettings,
  current: ReleaseCurrent,
  logged: Ref.Ref<ReadonlySet<string>>
): Effect.Effect<
  Option.Option<Fiber.Fiber<void>>,
  never,
  FileSystem.FileSystem
> =>
  pruneReleases(settings, current, logged).pipe(
    Effect.map(Option.some),
    Effect.catchCause(() =>
      Console.error("SHIP_PRUNE_FAILED").pipe(
        Effect.as(Option.none<Fiber.Fiber<void>>())
      )
    )
  );

export const prepareReleases = Effect.fn("Ship.prepareReleases")(
  function* prepareReleases(releases: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(releases, { mode: 0o700, recursive: true });
    yield* fs.writeFileString(`${releases}/.metadata_never_index`, "", {
      mode: 0o600,
    });
  }
);

export const recordReceipt =
  (
    ship: Pick<ShipSettingsValue, "keepReleases" | "receipts" | "releases">,
    shipping: Ref.Ref<ReleaseCurrent>,
    logged: Ref.Ref<ReadonlySet<string>>
  ) =>
  (receipt: typeof ShipReceipt.Type) =>
    Effect.gen(function* record() {
      const fs = yield* FileSystem.FileSystem;

      const line = yield* Schema.encodeEffect(
        Schema.fromJsonString(ShipReceipt)
      )(receipt);

      yield* fs.writeFileString(ship.receipts, `${line}\n`, {
        flag: "a",
        mode: 0o600,
      });
    }).pipe(
      Effect.mapError(
        () => new FleetError({ reason: "Deploy receipt write failed" })
      ),
      Effect.andThen(
        Ref.get(shipping).pipe(
          Effect.flatMap((now) =>
            receipt.result === "held"
              ? Effect.void
              : pruneSafely(
                  {
                    keep: clampKeep(ship.keepReleases),
                    receipts: ship.receipts,
                    releases: ship.releases,
                  },
                  now,
                  logged
                )
          ),
          Effect.asVoid
        )
      )
    );
