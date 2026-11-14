import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  PlatformError,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { runAction } from "../src/tool.ts";
import { fakeMailbox, quietSocket } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";

it.live.prop(
  "a local retirement changes list output only, send still receives Retired, and successful own acquisition clears stale retirement",
  [Schema.Literals(["example/peer-a", "example/peer-b"]), Schema.Boolean],
  ([name, overlayFailure]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      let failOverlayWrites = false;

      const filesystem: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (file, data, options) =>
          failOverlayWrites && file.includes(".retired.json.")
            ? Effect.fail(
                PlatformError.badArgument({
                  description: "Synthetic overlay write failure",
                  method: "writeFileString",
                  module: "FileSystem",
                })
              )
            : fs.writeFileString(file, data, options),
      };

      const peer = yield* identity(
        `did:web:${name.replace("/", ".")}.agents.example.invalid`
      );

      const original = fakeMailbox("accept");
      let rejected = 0;

      const http = HttpClient.make((request) => {
        const nsid = new URL(request.url).pathname;

        if (nsid.endsWith("mailbox.send")) {
          rejected += 1;

          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                { error: "Retired", message: "Retired; use example/successor" },
                { status: 410 }
              )
            )
          );
        }

        if (nsid.endsWith("identity.retireName")) {
          return Clock.currentTimeMillis.pipe(
            Effect.map((now) =>
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  by: "did:web:tester.agents.example.invalid",
                  did: "did:web:tester.agents.example.invalid",
                  name: "tester",
                  retiredAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
                })
              )
            )
          );
        }

        return original.http.execute(request);
      });

      yield* Effect.gen(function* clientProof() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;
        yield* directory.record(name, yield* document(peer));
        yield* directory.importRetired(["tester"]);
        failOverlayWrites = overlayFailure;
        const live = yield* Deferred.make<boolean>();
        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            onState: (reader) => {
              if (ReaderState.$is("Live")(reader)) {
                Deferred.doneUnsafe(live, Effect.succeed(true));
              }
            },
            pane: Option.none(),
            pid: 1,
            session: "retired-overlay-proof",
          },
          () => Effect.void
        );
        yield* Deferred.await(live);
        expect(Object.hasOwn(yield* directory.retired, "tester")).toBe(
          overlayFailure
        );
        failOverlayWrites = false;

        const before = yield* runAction("ratking", 1000, {
          action: "send",
          message: "hello",
          to: name,
        });

        const originalDirectory = yield* fs.readFileString(
          `${state}/directory.json`
        );

        const documents = yield* directory.documents;
        yield* directory.importRetired([name]);

        const after = yield* runAction("ratking", 1000, {
          action: "send",
          message: "hello",
          to: name,
        });

        expect(before.isError).toBe(true);
        expect(after.text).toBe(before.text);
        expect(after.text).toContain("Retired");
        expect(rejected).toBe(2);
        expect(yield* directory.documents).toEqual(documents);
        expect(yield* fs.readFileString(`${state}/directory.json`)).toBe(
          originalDirectory
        );
        expect((yield* ratking.list).map((entry) => entry.name)).not.toContain(
          name
        );

        const retired = yield* runAction("ratking", 1000, {
          action: "list",
          status: "retired",
        });

        expect(retired.isError).toBe(false);
        expect(retired.text).toContain(name);
        expect(retired.text).toContain(`${overlayFailure ? 2 : 1} shown`);
        expect(retired.text).toContain("retired");
        failOverlayWrites = overlayFailure;
        expect((yield* ratking.retire(Option.none())).name).toBe("tester");
        failOverlayWrites = false;
        expect(Object.hasOwn(yield* directory.retired, "tester")).toBe(true);
        yield* directory.clearRetired(name);
        expect((yield* ratking.list).map((entry) => entry.name)).toContain(
          name
        );
      }).pipe(
        Effect.provide(
          harness(state, http, [], {}, filesystem).pipe(
            Layer.provideMerge(quietSocket)
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 30_000 }
);
