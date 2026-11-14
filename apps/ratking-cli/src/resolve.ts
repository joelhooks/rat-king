/* oxlint-disable promise/prefer-await-to-callbacks -- Effect error mapping is not a Promise callback. */
import * as Deadline from "@rat-king/mailbox-client/deadline";
import type {
  Resolution,
  UnresolvedReason,
} from "@rat-king/ratking-client/resolve";
import { Cause, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";

export class ResolveError extends Schema.TaggedError<ResolveError>()(
  "ResolveError",
  { code: Schema.String, reason: Schema.String }
) {}

const failure = (code: string, reason: string) =>
  new ResolveError({ code, reason });

const Names = Schema.Array(Schema.NonEmptyString).check(
  Schema.makeFilter((names) => new Set(names).size === names.length)
);

export type Lookup<E = UnresolvedReason, R = never> = (
  name: string
) => Effect.Effect<Resolution, E, R>;

export const collectResolutions = Effect.fn("Resolve.collect")(
  function* collectResolutions<R>(
    names: readonly string[],
    lookup: Lookup<UnresolvedReason, R>
  ) {
    const results = yield* Effect.forEach(
      names,
      (name) =>
        Effect.suspend(() => lookup(name)).pipe(
          Deadline.timeout("10 seconds"),
          Effect.map((value) => ({ name, value })),
          Effect.catchCause((cause) => {
            const error = Option.getOrUndefined(Cause.findErrorOption(cause));

            const tag: UnresolvedReason =
              error === "unknown-name" ||
              error === "invalid-document" ||
              error === "did-mismatch"
                ? error
                : "refresh-failed";

            return Effect.succeed({ name, reason: tag });
          })
        ),
      { concurrency: 4 }
    );

    const resolved: Record<string, Resolution> = {};
    const unresolved: { name: string; reason: UnresolvedReason }[] = [];

    for (const result of results) {
      if ("value" in result) {
        Object.defineProperty(resolved, result.name, {
          configurable: true,
          enumerable: true,
          value: result.value,
          writable: true,
        });
      } else {
        unresolved.push(result);
      }
    }

    return { resolved, total: names.length, unresolved };
  }
);

export const writeResolutions = Effect.fn("Resolve.write")(
  function* writeResolutions<R>(
    namesFile: string,
    out: string,
    lookup: Lookup<UnresolvedReason, R>
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.resolve(out);

    if (yield* fs.exists(target)) {
      return yield* failure(
        "OutputExists",
        "Output file already exists; choose a new --out file to preserve existing work"
      );
    }

    const names = yield* fs.readFileString(namesFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Names))),
      Effect.mapError(() =>
        failure(
          "InvalidNames",
          "Could not read a JSON array of unique nonempty names; fix --names and retry with a new --out file"
        )
      )
    );

    const collected = yield* collectResolutions(names, lookup);
    const run = yield* (yield* SecureRandom.SecureRandom).uuidV4();
    const text = `${JSON.stringify({ ...collected, run })}\n`;

    const sha256 = yield* (yield* Digest.Digest).digestHex(
      Digest.sha256,
      new TextEncoder().encode(text)
    );

    yield* Effect.gen(function* publish() {
      const stage = yield* fs.makeTempDirectoryScoped({
        directory: path.dirname(target),
        prefix: ".ratking-resolve-",
      });

      const file = path.join(stage, "resolved.json");
      yield* fs.writeFileString(file, text, { flag: "wx", mode: 0o600 });
      yield* fs.link(file, target);
    }).pipe(Effect.scoped);

    return {
      resolved: Object.keys(collected.resolved).length,
      run,
      sha256,
      total: collected.total,
      unresolved: collected.unresolved.length,
    };
  },
  Effect.mapError((error) =>
    Schema.is(ResolveError)(error)
      ? error
      : failure(
          "ResolveWriteFailed",
          "Could not publish resolutions; verify the output parent exists, is writable and supports hard links, then retry with a new --out file"
        )
  )
);
