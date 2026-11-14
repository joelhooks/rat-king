import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { runRatking } from "../src/main.ts";
import { captured } from "./fixture.ts";

it.effect.prop(
  "retired-import is local, idempotent and preserves the identity directory byte for byte",
  [Schema.Boolean],
  ([invalid]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const config = `${root}/config.json`;
      const directory = `${root}/directory.json`;
      const input = `${root}/names.txt`;
      const original = "{}\n";
      yield* fs.writeFileString(directory, original);
      yield* fs.writeFileString(
        config,
        JSON.stringify({
          didTemplate: "did:web:{agent}.example.invalid",
          directory,
          endpoint: "https://mailbox.example.invalid",
          serviceDid: "did:web:mailbox.example.invalid",
          state: root,
        })
      );
      yield* fs.writeFileString(
        input,
        invalid
          ? "example/retired\nINVALID\n"
          : "\r\nexample/retired\r\nexample/retired\r\n"
      );
      const output = captured();

      const run = runRatking(["retired-import", "--file", input]).pipe(
        Effect.provideService(Console.Console, output.console),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ HOME: root, RATKING_CONFIG: config })
          )
        )
      );

      if (invalid) {
        yield* run.pipe(Effect.flip);
        expect(yield* fs.exists(`${root}/retired.json`)).toBe(false);
      } else {
        yield* run;
        expect(output.stdout).toEqual(['{"added":1,"already":1}']);
        yield* run;
        expect(output.stdout[1]).toBe('{"added":0,"already":2}');
        const overlay = yield* fs.readFileString(`${root}/retired.json`);
        expect(JSON.parse(overlay)).toEqual({
          "example/retired": { source: "import" },
        });
        expect((yield* fs.stat(`${root}/retired.json`)).mode % 0o1000).toBe(
          0o600
        );
      }

      expect(yield* fs.readFileString(directory)).toBe(original);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
