import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Names from "@rat-king/lexicon/identity.listNames";
import * as Retired from "@rat-king/lexicon/identity.listRetired";
import { Transport } from "@rat-king/lexicon/transport";
import { Effect, FileSystem, Path, Schema } from "effect";
import { expect } from "vitest";

import { snapshotWithTransport } from "../src/snapshot-command.ts";

it.effect(
  "requests both contracts through the signed transport and accepts empty lists",
  () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: string[] = [];

      const receipt = yield* snapshotWithTransport(
        "configured-placement",
        path.join(root, "out")
      ).pipe(
        Effect.provideService(
          Transport,
          Transport.of({
            request: (request) => {
              calls.push(request.nsid);
              expect(request.method).toBe("GET");
              expect(request.params).toEqual(
                request.nsid === Names.Method.nsid
                  ? { all: true, limit: 100 }
                  : { limit: 100 }
              );

              return Effect.succeed({
                body:
                  request.nsid === Names.Method.nsid
                    ? { names: [] }
                    : { retired: [] },
                kind: "json",
                status: 200,
              });
            },
          })
        )
      );

      expect(calls).toEqual([Names.Method.nsid, Retired.Method.nsid]);
      expect(receipt.totals).toEqual({ names: 0, retired: 0 });
      expect(receipt.pages).toEqual([
        { issuer: "configured-placement", names: 1, retired: 1 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "rejects invalid or refused pages without publishing or echoing remote bodies",
  {
    list: Schema.Literals(["names", "retired"]),
    status: Schema.Literals([200, 403, 500]),
  },
  ({ list, status }) =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();

      const error = yield* snapshotWithTransport(
        "configured-placement",
        path.join(root, "out")
      ).pipe(
        Effect.provideService(
          Transport,
          Transport.of({
            request: (request) =>
              Effect.succeed(
                request.nsid.endsWith(
                  list === "names" ? ".listNames" : ".listRetired"
                )
                  ? { body: "private-remote-body", kind: "text", status }
                  : { body: { names: [] }, kind: "json", status: 200 }
              ),
          })
        ),
        Effect.flip
      );

      expect(error.code).toBe(status === 200 ? "InvalidPage" : "PageRefused");
      expect(JSON.stringify(error)).not.toContain("private-remote-body");
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
