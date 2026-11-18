import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import {
  ensureIdentity,
  publicDocument,
} from "@rat-king/ratking-client/identity";
import { AgentName } from "@rat-king/ratking-client/name";
import { Arbitrary, Effect, FileSystem, Result, Schema } from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vitest";

import { harness } from "./harness.ts";

for (const kind of ["absent", "held", "listed", "reserved"] as const) {
  it.effect.prop(
    `a successor with ${kind} identity state mints only for an unlisted first start`,
    [Arbitrary.schema(AgentName), Arbitrary.schema(Schema.Boolean)],
    ([name, successor]) =>
      Effect.gen(function* proof() {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped();
        const secrets = new Map<string, string>();
        const http = HttpClient.make(() => Effect.die("Unexpected HTTP"));

        const layer = harness(state, http, [], {
          reserved:
            kind === "reserved"
              ? { [name]: { did: "did:web:reserved.example.invalid" } }
              : {},
          secrets,
        });

        yield* Effect.gen(function* scenario() {
          const directory = yield* Directory;

          if (kind === "held" || kind === "listed") {
            yield* ensureIdentity(name);
          }

          if (kind === "listed") {
            secrets.clear();
          }

          const result = yield* ensureIdentity(name, undefined, successor).pipe(
            Effect.result
          );

          const allowed = kind === "absent" || kind === "held";
          expect(Result.isSuccess(result)).toBe(allowed);
          expect(secrets.size).toBe(allowed ? 1 : 0);

          if (Result.isSuccess(result)) {
            const again = yield* ensureIdentity(name, undefined, true);
            expect(publicDocument(again)).toEqual(
              publicDocument(result.success)
            );
            expect((yield* directory.resolve(name)).did).toBe(again.did);
            expect(secrets.size).toBe(1);
          }
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { arbitrary: { runs: 5 }, timeout: 30_000 }
  );
}
