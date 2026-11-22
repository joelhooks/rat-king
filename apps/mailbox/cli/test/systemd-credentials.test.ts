import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Redacted, Schema } from "effect";
import { expect } from "vitest";

import { SecretSource } from "../../../../packages/alchemy-nest/src/secret-source.ts";
import { readCliIdentity } from "../identity.ts";
import { SecretStore, secretStoreLayer } from "../secrets.ts";

it.effect.prop(
  "mounted slots are read verbatim; wrong shapes, missing slots, paths, links and oversized files fail closed",
  [Schema.Int],
  ([id]) =>
    Effect.gen(function* check() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const name = "fixture-signer";
      const value = `fixture-${id}\n`;

      yield* fs.writeFileString(`${directory}/${name}`, value);
      yield* fs.writeFileString(`${directory}/large`, "x".repeat(65_537));
      yield* fs.symlink(`${directory}/${name}`, `${directory}/linked`);
      yield* fs.makeDirectory(`${directory}/nested`);

      yield* Effect.gen(function* resolve() {
        const store = yield* SecretStore;
        const alchemy = yield* SecretSource;

        expect(yield* store.lease(name)).toBe(value);
        expect(Redacted.value(yield* alchemy.resolve({ secret: name }))).toBe(
          value
        );
        expect(yield* readCliIdentity(name).pipe(Effect.flip)).toMatchObject({
          reason: "Systemd identity unavailable or invalid",
        });

        for (const bad of [
          "absent",
          "../fixture-signer",
          "fixture-signer\n",
          "large",
          "linked",
          "nested",
        ]) {
          expect(yield* store.lease(bad).pipe(Effect.isFailure)).toBe(true);
          expect(
            yield* alchemy.resolve({ secret: bad }).pipe(Effect.isFailure)
          ).toBe(true);
        }
      }).pipe(
        Effect.provide([SecretSource.layer, secretStoreLayer()]),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CREDENTIALS_DIRECTORY: directory,
              RAT_KING_SECRET_SOURCE: "systemd",
            })
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 } }
);
