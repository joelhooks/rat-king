import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { expect } from "vitest";

import { collectResolutions, writeResolutions } from "../src/resolve.ts";

it.effect.prop(
  "lookup defects and synchronous throws stay isolated and never expose exception text",
  {
    failure: Schema.Literals(["defect", "throw"]),
  },
  ({ failure }) =>
    Effect.gen(function* test() {
      const result = yield* collectResolutions(["broken", "okay"], (name) => {
        if (name === "broken") {
          if (failure === "throw") {
            throw new Error("private-error");
          }

          return Effect.die("private-error");
        }

        return Effect.succeed({
          did: "did:web:example.test",
          document: {
            authentication: [],
            id: "did:web:example.test",
            keyAgreement: [],
            verificationMethod: [],
          },
        });
      });

      expect(result.total).toBe(2);
      expect(Object.keys(result.resolved)).toEqual(["okay"]);
      expect(result.unresolved).toEqual([
        { name: "broken", reason: "refresh-failed" },
      ]);
      expect(JSON.stringify(result)).not.toContain("private-error");
    })
);

it.effect.prop(
  "failed staging or publication leaves no output or temporary files",
  {
    operation: Schema.Literals(["write", "link", "parent"]),
  },
  ({ operation }) =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const names = path.join(root, "names.json");

      const out =
        operation === "parent"
          ? path.join(root, "missing", "out")
          : path.join(root, "out");

      yield* fs.writeFileString(names, "[]");

      const broken = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          fs.link(operation === "link" ? path.join(root, "missing") : from, to),
        writeFileString: (file, data, options) =>
          fs.writeFileString(
            operation === "write" ? path.join(root, "missing", "file") : file,
            data,
            options
          ),
      });

      const error = yield* writeResolutions(names, out, () =>
        Effect.die("empty input")
      ).pipe(Effect.provideService(FileSystem.FileSystem, broken), Effect.flip);

      expect(error.code).toBe("ResolveWriteFailed");
      expect(yield* fs.readDirectory(root)).toEqual(["names.json"]);
    }).pipe(
      Effect.scoped,
      Effect.provide([NodeServices.layer, NodeCrypto.layer])
    )
);

it.effect(
  "an output created during lookup wins without being overwritten",
  () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const names = path.join(root, "names.json");
      const out = path.join(root, "out");
      yield* fs.writeFileString(names, '["agent"]');

      const error = yield* writeResolutions(names, out, () =>
        fs
          .writeFileString(out, "other writer", { flag: "wx" })
          .pipe(
            Effect.orDie,
            Effect.andThen(Effect.fail("unknown-name" as const))
          )
      ).pipe(Effect.flip);

      expect(error.code).toBe("ResolveWriteFailed");
      expect(yield* fs.readFileString(out)).toBe("other writer");
      expect((yield* fs.readDirectory(root)).toSorted()).toEqual([
        "names.json",
        "out",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide([NodeServices.layer, NodeCrypto.layer])
    )
);
