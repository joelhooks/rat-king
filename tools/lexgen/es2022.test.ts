import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect } from "vitest";

import { generate, walk } from "./generate.ts";

it.effect("generates no ES2023+ array methods", () =>
  Effect.gen(function* es2022() {
    const fs = yield* FileSystem.FileSystem;
    yield* generate({ root: ".", write: false });
    const files = yield* walk("packages/lexicon/src");

    for (const file of files) {
      expect(yield* fs.readFileString(file)).not.toMatch(
        /\.(?:toSorted|toReversed|toSpliced|with|findLast|findLastIndex)\s*\(/u
      );
    }
  }).pipe(Effect.provide(NodeServices.layer))
);
