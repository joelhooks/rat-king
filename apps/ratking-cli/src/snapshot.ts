/* oxlint-disable promise/prefer-await-to-callbacks -- Effect error mapping is not a Promise callback. */
import type * as Names from "@rat-king/lexicon/identity.listNames";
import type * as Retired from "@rat-king/lexicon/identity.listRetired";
import { canonicalJson } from "@rat-king/mailbox-client/owner-queue";
import { Effect, FileSystem, Path, Schema } from "effect";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";

export class SnapshotError extends Schema.TaggedError<SnapshotError>()(
  "SnapshotError",
  { code: Schema.String, reason: Schema.String }
) {}

export interface SnapshotIssuer {
  readonly label: string;
  readonly names: (
    cursor?: string
  ) => Effect.Effect<typeof Names.Output.Encoded, SnapshotError>;
  readonly retired: (
    cursor?: string
  ) => Effect.Effect<typeof Retired.Output.Encoded, SnapshotError>;
}

const failure = (code: string, reason: string) =>
  new SnapshotError({ code, reason });

export const SNAPSHOT_MAX_PAGES = 1000;

const pages = Effect.fn("Snapshot.pages")(function* pages<A>(
  label: string,
  list: string,
  fetch: (
    cursor?: string
  ) => Effect.Effect<
    { readonly entries: readonly A[]; readonly cursor?: string },
    SnapshotError
  >
) {
  const entries: A[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let count = 0;

  while (true) {
    const page = yield* fetch(cursor);
    count += 1;
    entries.push(...page.entries);

    if (page.cursor === undefined) {
      return { count, entries };
    }

    if (count >= SNAPSHOT_MAX_PAGES) {
      return yield* failure(
        "SnapshotTooLarge",
        `${label} ${list} exceeded ${SNAPSHOT_MAX_PAGES} pages; no partial snapshot was written`
      );
    }

    if (seen.has(page.cursor)) {
      return yield* failure(
        "RepeatedCursor",
        `${label} ${list} page ${count} repeated a cursor; pagination cannot prove completeness`
      );
    }

    seen.add(page.cursor);
    ({ cursor } = page);
  }
});

export const collectSnapshot = Effect.fn("Snapshot.collect")(
  function* collectSnapshot(issuers: readonly SnapshotIssuer[]) {
    if (
      issuers.length === 0 ||
      issuers.some((issuer) => issuer.label.trim().length === 0)
    ) {
      return yield* failure(
        "MissingIssuerLabel",
        "Configure at least one issuer with a nonempty placement label"
      );
    }

    const names = new Map<string, typeof Names.Entry.Encoded>();

    const retired = new Map<
      string,
      (typeof Retired.Output.Encoded.retired)[number]
    >();

    const placements = new Map<string, string>();
    const counts: { issuer: string; names: number; retired: number }[] = [];

    for (const issuer of issuers) {
      const live = yield* pages(issuer.label, "names", (cursor) =>
        issuer
          .names(cursor)
          .pipe(Effect.map((page) => ({ ...page, entries: page.names })))
      );

      const dead = yield* pages(issuer.label, "retired", (cursor) =>
        issuer
          .retired(cursor)
          .pipe(Effect.map((page) => ({ ...page, entries: page.retired })))
      );

      for (const entry of live.entries) {
        const previous = names.get(entry.name);

        if (
          previous !== undefined &&
          (previous.did !== entry.did ||
            canonicalJson(previous.document) !== canonicalJson(entry.document))
        ) {
          return yield* failure(
            "ConflictingName",
            `Issuers returned different documents for name ${entry.name}`
          );
        }

        if (previous === undefined) {
          names.set(entry.name, entry);
          placements.set(entry.name, issuer.label);
        }
      }

      for (const entry of dead.entries) {
        const previous = retired.get(entry.name);

        if (
          previous !== undefined &&
          canonicalJson(previous) !== canonicalJson(entry)
        ) {
          return yield* failure(
            "ConflictingRetirement",
            `Issuers returned different retirements for name ${entry.name}`
          );
        }

        retired.set(entry.name, entry);
      }

      counts.push({
        issuer: issuer.label,
        names: live.count,
        retired: dead.count,
      });
    }

    return {
      issuers: Object.fromEntries(placements),
      names: [...names.values()],
      pages: counts,
      retired: [...retired.values()],
    };
  }
);

const sha256 = Effect.fn("Snapshot.sha256")(function* sha256(text: string) {
  return yield* (yield* Digest.Digest).digestHex(
    Digest.sha256,
    new TextEncoder().encode(text)
  );
});

const jsonLine = (value: Schema.Json) => `${JSON.stringify(value)}\n`;

export const writeSnapshot = Effect.fn("Snapshot.write")(
  function* writeSnapshot(issuers: readonly SnapshotIssuer[], out: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.resolve(out);

    if (yield* fs.exists(target)) {
      return yield* failure(
        "OutputExists",
        "Output directory already exists; choose a new --out directory to preserve existing work"
      );
    }

    const collected = yield* collectSnapshot(issuers);
    const snapshot = yield* (yield* SecureRandom.SecureRandom).uuidV4();

    const files = {
      "issuers.json": jsonLine(collected.issuers),
      "names.json": jsonLine({
        complete: true,
        names: collected.names,
        snapshot,
        total: collected.names.length,
      }),
      "retired.json": jsonLine({
        complete: true,
        retired: collected.retired,
        snapshot,
        total: collected.retired.length,
      }),
    };

    const hashes = {
      "issuers.json": yield* sha256(files["issuers.json"]),
      "names.json": yield* sha256(files["names.json"]),
      "retired.json": yield* sha256(files["retired.json"]),
    };

    yield* Effect.gen(function* publish() {
      const stage = yield* fs.makeTempDirectoryScoped({
        directory: path.dirname(target),
        prefix: ".ratking-snapshot-",
      });

      const bundle = path.join(stage, "bundle");
      yield* fs.makeDirectory(bundle, { mode: 0o700 });

      for (const file of [
        "names.json",
        "retired.json",
        "issuers.json",
      ] as const) {
        yield* fs.writeFileString(path.join(bundle, file), files[file], {
          flag: "wx",
          mode: 0o600,
        });
      }

      yield* fs.rename(bundle, target);
    }).pipe(Effect.scoped);

    return {
      pages: collected.pages,
      sha256: hashes,
      snapshot,
      totals: {
        names: collected.names.length,
        retired: collected.retired.length,
      },
    };
  },
  Effect.mapError((error) =>
    Schema.is(SnapshotError)(error)
      ? error
      : failure(
          "SnapshotWriteFailed",
          "Could not publish snapshot; verify the output parent exists and is writable"
        )
  )
);
