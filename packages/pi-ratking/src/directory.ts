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
  Schema,
} from "effect";

import { Settings } from "./config.ts";
import { withLock } from "./lock.ts";
import { AgentName, canonicalName, Did } from "./name.ts";

export const Entry = Schema.Struct({ did: Did, document: Document });

export const Entries = Schema.Record(AgentName, Entry);

export type EntriesValue = typeof Entries.Type;

export interface Resolved {
  readonly name: string;
  readonly did: string;
  readonly document: PeerDocument;
}

export interface Listed {
  readonly name: string;
  readonly did: string;
  readonly reserved: boolean;
  readonly aliases: readonly string[];
}

export class UnknownName extends Schema.TaggedError<UnknownName>()(
  "UnknownName",
  { name: Schema.String, reason: Schema.String }
) {}

export class DirectoryError extends Schema.TaggedError<DirectoryError>()(
  "DirectoryError",
  { reason: Schema.String }
) {}

export class Directory extends Context.Service<
  Directory,
  {
    readonly resolve: (name: string) => Effect.Effect<Resolved, UnknownName>;
    readonly nameOf: (did: string) => Effect.Effect<Option.Option<string>>;
    readonly list: Effect.Effect<readonly Listed[]>;
    readonly documents: Effect.Effect<readonly PeerDocument[]>;
    readonly record: (
      name: string,
      document: PeerDocument
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

export const directoryLayer = Layer.effect(
  Directory,
  Effect.gen(function* makeDirectory() {
    const settings = yield* Settings;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const entries = fs.readFileString(settings.directory).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Entries))
      ),
      Effect.orElseSucceed((): EntriesValue => ({}))
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
        return yield* new UnknownName({
          name: requested,
          reason: "No Rat King identity has this name",
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

      return { did: did.value, document, name };
    });

    return Directory.of({
      documents: Effect.gen(function* documents() {
        const known = yield* entries;
        const docs = yield* configured;

        return [
          ...docs,
          ...Object.values(known).map((entry) => entry.document),
        ];
      }),
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
          .map(([name, entry]) => ({
            aliases: [],
            did: entry.did,
            name,
            reserved: false,
          }));

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
        function* record(name, document) {
          yield* withLock(
            path.join(settings.state, "locks"),
            "directory",
            Effect.gen(function* write() {
              const known = yield* entries;

              const next = yield* Schema.encodeEffect(
                Schema.fromJsonString(Entries)
              )({ ...known, [name]: { did: document.id, document } });

              yield* writePrivateJson(settings.directory, next);
            })
          );
        },
        Effect.mapError(
          () => new DirectoryError({ reason: "Directory write failed" })
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path)
      ),
      resolve,
    });
  })
);
