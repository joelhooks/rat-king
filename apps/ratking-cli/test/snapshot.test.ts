// @effect-diagnostics asyncFunction:off -- WebCrypto independently verifies exported file hashes at a Promise boundary.
import { NodeServices, NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Names from "@rat-king/lexicon/identity.listNames";
import { Retirement } from "@rat-king/lexicon/identity.retireName";
import { Effect, FileSystem, Path, Schema, Layer } from "effect";
import { expect } from "vitest";

import {
  collectSnapshot,
  SnapshotError,
  writeSnapshot,
} from "../src/snapshot.ts";
import type { SnapshotIssuer } from "../src/snapshot.ts";

const Counts = Schema.Struct({
  names: Schema.Int.check(Schema.isBetween({ maximum: 35, minimum: 21 })),
  retired: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 2 })),
});

const entry = (index: number, version = "a") =>
  Schema.decodeUnknownSync(Schema.toEncoded(Names.Entry))({
    did: `did:web:example.test:agent${index}`,
    document: {
      authentication: [],
      id: `did:web:example.test:agent${index}`,
      keyAgreement: [],
      service: [],
      verificationMethod: [],
      version,
    },
    name: `agent${index}`,
  });

const withCursor = <A extends object>(
  data: A,
  index: number,
  total: number
) => {
  if (index + 1 < total) {
    Object.assign(data, { cursor: String(index + 1) });
  }

  return data;
};

const fake = (names: number, retired: number): SnapshotIssuer => ({
  label: "placement-test",
  names: (cursor) => {
    const index = Number(cursor ?? 0);

    return Effect.succeed(withCursor({ names: [entry(index)] }, index, names));
  },
  retired: (cursor) => {
    const index = Number(cursor ?? 0);

    return Effect.succeed(
      withCursor(
        {
          retired: [
            {
              by: "did:web:example.test:operator",
              did: `did:web:example.test:retired${index}`,
              name: `retired${index}`,
              retiredAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
        index,
        retired
      )
    );
  },
});

const workspace = Effect.gen(function* workspace() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();

  return { fs, out: path.join(root, "snapshot"), path, root };
});

it.effect.prop(
  "flattens every page, including more than twenty, and publishes one private bundle",
  Counts.fields,
  (counts) =>
    Effect.gen(function* test() {
      const { fs, out, path } = yield* workspace;

      const receipt = yield* writeSnapshot(
        [fake(counts.names, counts.retired)],
        out
      );

      const names = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            complete: Schema.Boolean,
            names: Schema.Array(Schema.toEncoded(Names.Entry)),
            snapshot: Schema.String,
            total: Schema.Int,
          })
        )
      )(yield* fs.readFileString(path.join(out, "names.json")));

      const retired = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            complete: Schema.Boolean,
            retired: Schema.Array(Schema.toEncoded(Retirement)),
            snapshot: Schema.String,
            total: Schema.Int,
          })
        )
      )(yield* fs.readFileString(path.join(out, "retired.json")));

      const issuers = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
      )(yield* fs.readFileString(path.join(out, "issuers.json")));

      expect(names).toEqual({
        complete: true,
        names: Array.from({ length: counts.names }, (_, i) => entry(i)),
        snapshot: receipt.snapshot,
        total: counts.names,
      });
      expect(retired.snapshot).toBe(names.snapshot);
      expect(retired.complete).toBe(true);
      expect(retired.total).toBe(counts.retired);
      expect(retired.retired).toHaveLength(counts.retired);
      expect(receipt.pages).toEqual([
        {
          issuer: "placement-test",
          names: counts.names,
          retired: counts.retired,
        },
      ]);

      for (const file of [
        "names.json",
        "retired.json",
        "issuers.json",
      ] as const) {
        expect((yield* fs.stat(path.join(out, file))).mode % 0o1000).toBe(
          0o600
        );
        const bytes = yield* fs.readFile(path.join(out, file));

        const hash = new Uint8Array(
          yield* Effect.promise(
            async () =>
              await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
          )
        );

        expect(receipt.sha256[file]).toBe(
          Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")
        );
      }

      expect(issuers).toEqual(
        Object.fromEntries(
          Array.from({ length: counts.names }, (_, i) => [
            `agent${i}`,
            "placement-test",
          ])
        )
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
    ),
  { arbitrary: { runs: 5 } }
);

it.effect.prop(
  "a failed page in either list never publishes files",
  {
    failAt: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
    list: Schema.Literals(["names", "retired"]),
  },
  ({ failAt, list }) =>
    Effect.gen(function* test() {
      const { fs, out, root } = yield* workspace;
      const issuer = fake(8, 8);
      let calls = 0;

      const fail =
        <A>(fetch: (cursor?: string) => Effect.Effect<A, SnapshotError>) =>
        (cursor?: string) => {
          calls += 1;

          return calls === failAt
            ? Effect.fail(
                new SnapshotError({
                  code: "PageFailed",
                  reason: "fake page failed",
                })
              )
            : fetch(cursor);
        };

      const broken =
        list === "names"
          ? { ...issuer, names: fail(issuer.names) }
          : { ...issuer, retired: fail(issuer.retired) };

      yield* writeSnapshot([broken], out).pipe(Effect.flip);
      expect(yield* fs.exists(out)).toBe(false);
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
    )
);

it.effect.prop(
  "rejects cursor cycles in either list with a named error and no files",
  {
    list: Schema.Literals(["names", "retired"]),
    period: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
  },
  ({ list, period }) =>
    Effect.gen(function* test() {
      const { fs, out, root } = yield* workspace;
      const issuer = fake(1, 1);
      let calls = 0;

      const cycle =
        <A>(fetch: () => Effect.Effect<A, SnapshotError>) =>
        () =>
          fetch().pipe(
            Effect.map((page) => {
              calls += 1;

              return { ...page, cursor: String(calls % period) };
            })
          );

      const looping =
        list === "names"
          ? { ...issuer, names: cycle(issuer.names) }
          : { ...issuer, retired: cycle(issuer.retired) };

      const error = yield* writeSnapshot([looping], out).pipe(Effect.flip);
      expect(error.code).toBe("RepeatedCursor");
      expect(calls).toBe(period + 1);
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
    )
);

it.effect(
  "refuses conflicting documents across issuers before publishing",
  () =>
    Effect.gen(function* test() {
      const { fs, out, root } = yield* workspace;

      const other = {
        ...fake(1, 1),
        label: "other",
        names: () => Effect.succeed({ names: [entry(0, "b")] }),
      };

      const error = yield* writeSnapshot([fake(1, 1), other], out).pipe(
        Effect.flip
      );

      expect(error.code).toBe("ConflictingName");
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
    )
);

it.effect.prop(
  "write or rename failures leave no published bundle or temporary files",
  {
    operation: Schema.Literals([
      "names.json",
      "retired.json",
      "issuers.json",
      "rename",
    ]),
  },
  ({ operation }) =>
    Effect.gen(function* test() {
      const { fs, out, path, root } = yield* workspace;

      const broken = FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) =>
          operation === "rename"
            ? fs.rename(path.join(root, "missing"), to)
            : fs.rename(from, to),
        writeFileString: (file, data, options) =>
          path.basename(file) === operation
            ? fs.writeFileString(
                path.join(root, "missing", "file"),
                data,
                options
              )
            : fs.writeFileString(file, data, options),
      });

      const error = yield* writeSnapshot([fake(1, 1)], out).pipe(
        Effect.provideService(FileSystem.FileSystem, broken),
        Effect.flip
      );

      expect(error.code).toBe("SnapshotWriteFailed");
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
    )
);

it.effect(
  "preserves existing output and uses a fresh run id for each new bundle",
  () =>
    Effect.gen(function* test() {
      const { fs, out, path, root } = yield* workspace;
      const first = yield* writeSnapshot([fake(1, 1)], out);
      const bytes = yield* fs.readFileString(path.join(out, "names.json"));
      const error = yield* writeSnapshot([fake(2, 2)], out).pipe(Effect.flip);
      expect(error.code).toBe("OutputExists");
      expect(yield* fs.readFileString(path.join(out, "names.json"))).toBe(
        bytes
      );

      const second = yield* writeSnapshot(
        [fake(1, 1)],
        path.join(root, "second")
      );

      expect(second.snapshot).not.toBe(first.snapshot);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
    )
);

it.effect(
  "deduplicates identical documents while retaining the first configured placement",
  () =>
    Effect.gen(function* test() {
      const result = yield* collectSnapshot([
        fake(1, 1),
        { ...fake(1, 1), label: "other" },
      ]);

      expect(result.names).toEqual([entry(0)]);
      expect(result.issuers).toEqual({ agent0: "placement-test" });
    })
);
