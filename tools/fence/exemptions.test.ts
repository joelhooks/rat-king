import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { expect } from "vitest";

import { blobHash, exemptions, isExempt } from "./exemptions.ts";
import { violations } from "./rules.ts";
import { execute, scan } from "./scan.ts";

const vectorPath =
  "packages/envelope/test/vectors/rfc9180-p256-sha256-aes128gcm-base.json";

it.effect(
  "exemptions require exact bytes, path and rule; no unrelated rule is exempt",
  () =>
    Effect.gen(function* exactApproval() {
      const fs = yield* FileSystem.FileSystem;
      const bytes = yield* fs.readFile(vectorPath);
      const sha256 = blobHash(bytes);
      expect(isExempt(vectorPath, sha256, "secret-name")).toBe(true);
      expect(isExempt(vectorPath, sha256, "gitleaks:generic-api-key")).toBe(
        true
      );
      expect(isExempt(vectorPath, sha256, "email")).toBe(false);
      expect(isExempt(vectorPath, sha256, "gitleaks:private-key")).toBe(false);
      expect(isExempt("other.json", sha256, "secret-name")).toBe(false);
      expect(
        isExempt(
          vectorPath,
          blobHash(`${new TextDecoder().decode(bytes)} `),
          "secret-name"
        )
      ).toBe(false);
      expect(
        violations({
          content: new TextDecoder().decode(bytes),
          inventory: null,
          name: vectorPath,
        })
      ).toEqual([]);

      for (const entry of exemptions) {
        expect(blobHash(yield* fs.readFile(entry.path))).toBe(entry.sha256);
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "the full generic fence honours approved RFC data, rejects edits and relocation",
  () =>
    Effect.gen(function* completeFence() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const content = yield* fs.readFile(vectorPath);
      const config = yield* fs.readFile("tools/fence/gitleaks.toml");
      yield* fs.makeDirectory(path.join(root, "tools/fence"), {
        recursive: true,
      });
      yield* fs.writeFile(path.join(root, "tools/fence/gitleaks.toml"), config);

      const git = yield* execute({
        args: ["init", "--quiet"],
        cwd: root,
        executable: "git",
      });

      expect(git.code).toBe(0);
      yield* fs.makeDirectory(path.dirname(path.join(root, vectorPath)), {
        recursive: true,
      });
      yield* fs.writeFile(path.join(root, vectorPath), content);
      expect((yield* scan({ generic: true, mode: "tree", root })).generic).toBe(
        true
      );
      yield* fs.writeFileString(
        path.join(root, vectorPath),
        `${new TextDecoder().decode(content)} `
      );
      expect(
        yield* scan({ generic: true, mode: "tree", root }).pipe(
          Effect.isFailure
        )
      ).toBe(true);
      yield* fs.writeFile(path.join(root, vectorPath), content);
      yield* fs.writeFile(path.join(root, "other.json"), content);
      expect(
        yield* scan({ generic: true, mode: "tree", root }).pipe(
          Effect.isFailure
        )
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
);
