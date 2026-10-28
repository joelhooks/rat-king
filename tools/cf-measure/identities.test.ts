import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Result, Schema } from "effect";

import {
  Documents,
  importAgreement,
  importSigning,
} from "../../packages/mailbox-client/src/index.ts";
import { generate, outside, readInputs } from "./identities.ts";
import { testDid } from "./model.ts";

it.effect(
  "fresh external files import as real P-256 keys; documents contain no private coordinates",
  () =>
    Effect.gen(function* fresh() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "cf-measure-",
      });

      const target = path.join(directory, "inputs");

      yield* generate(target, 2);

      const { inputs, documents } = yield* readInputs(
        target,
        path.join(target, "documents.json")
      );

      const all = [inputs.hosted, inputs.service, ...inputs.readers];

      expect(new Set(all.map((identity) => identity.did)).size).toBe(4);
      expect(all.every((identity) => testDid(identity.did))).toBe(true);
      expect(Schema.is(Documents)(documents)).toBe(true);
      expect(JSON.stringify(documents)).not.toContain('"d":');
      expect(
        (yield* fs.stat(path.join(target, "inputs.json"))).mode % 0o1000
      ).toBe(0o600);
      expect((yield* fs.stat(target)).mode % 0o1000).toBe(0o700);

      for (const identity of all) {
        expect((yield* importSigning(identity)).algorithm.name).toBe("ECDSA");
        expect((yield* importAgreement(identity)).algorithm.name).toBe("ECDH");
      }

      const duplicate = yield* generate(target, 2).pipe(Effect.result);
      const repo = yield* outside(import.meta.dirname).pipe(Effect.result);

      expect(Result.isFailure(duplicate)).toBe(true);
      expect(Result.isFailure(repo)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("private decode failures do not disclose key material", () =>
  Effect.gen(function* privateFailure() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "cf-measure-",
    });

    const input = path.join(directory, "inputs.json");

    yield* fs.writeFileString(input, '{"signing":{"d":"private-marker"}}', {
      mode: 0o600,
    });

    const result = yield* readInputs(
      directory,
      path.join(directory, "documents.json")
    ).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-marker");
  }).pipe(Effect.provide(NodeServices.layer))
);
