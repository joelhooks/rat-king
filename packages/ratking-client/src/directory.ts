/* oxlint-disable eslint/max-classes-per-file -- Effect service and Schema contracts share their owning port. */
import { Document, Documents } from "@rat-king/mailbox-client";
import type { PeerDocument } from "@rat-king/mailbox-client";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Record,
  Schema,
} from "effect";

import { Settings } from "./config.ts";
import { suggestNames } from "./directory-view.ts";
import { ForkParent } from "./fork.ts";
import { withLock } from "./lock.ts";
import { AgentName, canonicalName, Did } from "./name.ts";

export const Entry = Schema.Struct({
  did: Did,
  document: Document,
  parent: Schema.optionalKey(ForkParent),
});

export const Entries = Schema.Record(AgentName, Entry);

export type EntriesValue = typeof Entries.Type;

export const LocalRetirement = Schema.Struct({
  retiredAt: Schema.optionalKey(Schema.Finite),
  source: Schema.Literals(["import", "retire"]),
  successor: Schema.optionalKey(AgentName),
});

export const RetiredNames = Schema.Record(AgentName, LocalRetirement);

export type RetiredNamesValue = typeof RetiredNames.Type;

export interface Resolved {
  readonly name: string;
  readonly did: string;
  readonly document: PeerDocument;
  readonly parent?: typeof ForkParent.Type;
  readonly roleTarget?: boolean;
  readonly status?: "live" | "idle" | "retired" | "unknown";
}

export interface Listed {
  readonly name: string;
  readonly did: string;
  readonly reserved: boolean;
  readonly aliases: readonly string[];
  readonly parent?: typeof ForkParent.Type;
  readonly roleTarget?: boolean;
  readonly status?: Resolved["status"];
}

export class UnknownName extends Schema.TaggedError<UnknownName>()(
  "UnknownName",
  {
    name: Schema.String,
    reason: Schema.String,
    suggestions: Schema.optionalKey(Schema.Array(Schema.String)),
  }
) {}

export class DirectoryError extends Schema.TaggedError<DirectoryError>()(
  "DirectoryError",
  { reason: Schema.String }
) {}

export class Directory extends Context.Service<
  Directory,
  {
    readonly retired: Effect.Effect<RetiredNamesValue>;
    readonly importRetired: (
      names: readonly string[]
    ) => Effect.Effect<
      { readonly added: number; readonly already: number },
      DirectoryError
    >;
    readonly recordRetired: (
      name: string,
      successor?: string
    ) => Effect.Effect<void, DirectoryError>;
    readonly clearRetired: (
      name: string
    ) => Effect.Effect<void, DirectoryError>;
    readonly resolve: (name: string) => Effect.Effect<Resolved, UnknownName>;
    readonly nameOf: (did: string) => Effect.Effect<Option.Option<string>>;
    readonly list: Effect.Effect<readonly Listed[]>;
    readonly documents: Effect.Effect<readonly PeerDocument[]>;
    readonly record: (
      name: string,
      document: PeerDocument,
      parent?: typeof ForkParent.Type
    ) => Effect.Effect<void, DirectoryError>;
  }
>()("pi-ratking/Directory") {}

export const writePrivateJson = Effect.fn("RatKing.writePrivateJson")(
  function* writePrivateJson(file: string, json: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;

    const temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${now}.tmp`
    );

    yield* fs.makeDirectory(path.dirname(file), {
      mode: 0o700,
      recursive: true,
    });
    yield* fs.writeFileString(temp, json, { flag: "wx", mode: 0o600 });
    yield* fs.rename(temp, file);
  }
);

const emptyEntries: EntriesValue = {};

export const readDirectoryEntries = Effect.fn("Directory.readEntries")(
  function* readEntries(file: string) {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(file).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(Entries))(raw, {
          onExcessProperty: "error",
        })
      ),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed(emptyEntries)
      )
    );
  },
  Effect.mapError(
    () =>
      new DirectoryError({
        reason: "Local identity directory is unreadable; nothing was written",
      })
  )
);

export const directoryLayer = Layer.effect(
  Directory,
  Effect.gen(function* makeDirectory() {
    const settings = yield* Settings;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const overlayFile = path.join(settings.state, "retired.json");

    const readRetired = Effect.gen(function* readRetired() {
      if (!(yield* fs.exists(overlayFile))) {
        return {};
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(RetiredNames))(
        yield* fs.readFileString(overlayFile)
      );
    }).pipe(
      Effect.mapError(
        () =>
          new DirectoryError({
            reason:
              "Local retired overlay is unreadable; identity directory was not changed",
          })
      )
    );

    const modifyRetired = <A>(
      change: (known: RetiredNamesValue) => {
        readonly changed: boolean;
        readonly next: RetiredNamesValue;
        readonly result: A;
      }
    ) =>
      withLock(
        path.join(settings.state, "locks"),
        "directory",
        Effect.gen(function* updateRetiredOverlay() {
          const update = change(yield* readRetired);

          if (update.changed) {
            yield* writePrivateJson(
              overlayFile,
              yield* Schema.encodeEffect(Schema.fromJsonString(RetiredNames))(
                update.next
              )
            );
          }

          return update.result;
        })
      ).pipe(
        Effect.mapError(
          () =>
            new DirectoryError({
              reason:
                "Local retired overlay update failed; identity directory was not changed",
            })
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path)
      );

    const readEntries = readDirectoryEntries(settings.directory).pipe(
      Effect.provideService(FileSystem.FileSystem, fs)
    );

    const entries = readEntries.pipe(
      Effect.tapError((failure) => Effect.logWarning(failure.reason)),
      Effect.orElseSucceed(() => emptyEntries)
    );

    const configured = Effect.all(
      settings.documents.map((file) =>
        fs.readFileString(file).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Documents))),
          Effect.orElseSucceed((): readonly PeerDocument[] => [])
        )
      )
    ).pipe(Effect.map((groups) => groups.flat()));

    const reservedDid = (name: string) =>
      Option.fromNullishOr(settings.reserved[name]?.did);

    const resolve = Effect.fn("Directory.resolve")(function* resolve(
      requested: string
    ) {
      const name = canonicalName(settings.reserved, requested);
      const known = yield* entries;
      const documents = yield* configured;

      const did = Option.orElse(reservedDid(name), () =>
        Option.fromNullishOr(known[name]?.did)
      );

      if (Option.isNone(did)) {
        const suggestions = suggestNames(requested, [
          ...Object.keys(settings.reserved),
          ...Object.keys(known),
        ]);

        return yield* new UnknownName({
          name: requested,
          reason: `No Rat King identity has this name${suggestions.length === 0 ? "" : `; did you mean ${suggestions.join(", ")}?`}`,
          suggestions,
        });
      }

      const document =
        known[name]?.did === did.value
          ? known[name]?.document
          : documents.find((candidate) => candidate.id === did.value);

      if (document === undefined) {
        return yield* new UnknownName({
          name: requested,
          reason: "No public document is known for this name",
        });
      }

      const resolved: Resolved = { did: did.value, document, name };
      const parent = known[name]?.parent;

      if (parent !== undefined) {
        Object.assign(resolved, { parent });
      }

      return resolved;
    });

    return Directory.of({
      clearRetired: Effect.fn("Directory.clearRetired")(
        function* clearRetired(name) {
          yield* modifyRetired((known) => {
            const next = Record.remove(known, name);

            return {
              changed: Object.hasOwn(known, name),
              next,
              result: undefined,
            };
          });
        }
      ),
      documents: Effect.gen(function* documents() {
        const known = yield* entries;
        const docs = yield* configured;

        return [
          ...docs,
          ...Object.values(known).map((entry) => entry.document),
        ];
      }),
      importRetired: Effect.fn("Directory.importRetired")(
        function* importRetired(names) {
          const validated = yield* Schema.decodeUnknownEffect(
            Schema.Array(AgentName)
          )(names).pipe(
            Effect.mapError(
              () =>
                new DirectoryError({
                  reason: "Invalid name in retired import; nothing was written",
                })
            )
          );

          return yield* modifyRetired((known) => {
            const next = { ...known };
            let added = 0;
            let already = 0;

            for (const name of validated) {
              if (Object.hasOwn(next, name)) {
                already += 1;
              } else {
                next[name] = { source: "import" };
                added += 1;
              }
            }

            return { changed: added > 0, next, result: { added, already } };
          });
        }
      ),
      list: Effect.gen(function* list() {
        const known = yield* entries;

        const reserved = Object.entries(settings.reserved).map(
          ([name, entry]) => ({
            aliases: entry.aliases ?? [],
            did: entry.did,
            name,
            reserved: true,
          })
        );

        const minted = Object.entries(known)
          .filter(([name]) => !Object.hasOwn(settings.reserved, name))
          .map(([name, entry]) => {
            const listed: Listed = {
              aliases: [],
              did: entry.did,
              name,
              reserved: false,
            };

            if (entry.parent !== undefined) {
              Object.assign(listed, { parent: entry.parent });
            }

            return listed;
          });

        return [...reserved, ...minted].toSorted((a, b) =>
          a.name.localeCompare(b.name)
        );
      }),
      nameOf: Effect.fn("Directory.nameOf")(function* nameOf(did) {
        const known = yield* entries;

        const reserved = Object.entries(settings.reserved).find(
          ([, entry]) => entry.did === did
        );

        const minted = Object.entries(known).find(
          ([, entry]) => entry.did === did
        );

        return Option.fromNullishOr((reserved ?? minted)?.[0]);
      }),
      record: Effect.fn("Directory.record")(
        function* record(name, document, parent) {
          yield* withLock(
            path.join(settings.state, "locks"),
            "directory",
            Effect.gen(function* write() {
              const known = yield* readEntries;

              const entry: typeof Entry.Type = { did: document.id, document };
              const lineage = parent ?? known[name]?.parent;

              if (lineage !== undefined) {
                Object.assign(entry, { parent: lineage });
              }

              const next = yield* Schema.encodeEffect(
                Schema.fromJsonString(Entries)
              )({ ...known, [name]: entry });

              yield* writePrivateJson(settings.directory, next);
            })
          );
        },
        Effect.mapError((failure) =>
          Schema.is(DirectoryError)(failure)
            ? failure
            : new DirectoryError({ reason: "Directory write failed" })
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path)
      ),
      recordRetired: Effect.fn("Directory.recordRetired")(
        function* recordRetired(name, destination) {
          const raw = {
            retiredAt: yield* Clock.currentTimeMillis,
            source: "retire",
          };

          if (destination !== undefined) {
            Object.assign(raw, { successor: destination });
          }

          const record = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ name: AgentName, retirement: LocalRetirement })
          )({ name, retirement: raw }).pipe(
            Effect.mapError(
              () => new DirectoryError({ reason: "Invalid local retirement" })
            )
          );

          yield* modifyRetired((known) => ({
            changed: true,
            next: { ...known, [record.name]: record.retirement },
            result: undefined,
          }));
        }
      ),
      resolve,
      retired: readRetired.pipe(
        Effect.tapError((failure) => Effect.logWarning(failure.reason)),
        Effect.orElseSucceed((): RetiredNamesValue => ({}))
      ),
    });
  })
);
