import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { runAction } from "../src/tool.ts";
import { fakeMailbox, quietSocket } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";

const Typo = Schema.Literals(["project/desx", "project/dek", "project/deskx"]);

it.live.prop(
  "directory suggestions survive real send, ask and recalled-reply error paths; list shows roles with their role lines, list-cwd the bounded directory without DIDs, and all: true the full directory",
  [Arbitrary.schema(Typo)],
  ([typo]) =>
    Effect.gen(function* directoryProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();

      const { http } = fakeMailbox("reject", [
        { name: "proj", role: "Project desk", target: "project/desk" },
      ]);

      const peer = yield* identity("did:web:peer.example.invalid");
      yield* Effect.gen(function* proof() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;
        const absent = yield* directory.resolve("unrelated").pipe(Effect.flip);

        expect(absent.reason).not.toContain("did you mean");
        yield* directory.record("project/desk", yield* document(peer));
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
            session: "directory-proof",
          },
          () => Effect.void
        );
        yield* Deferred.await(live);
        const error = yield* directory.resolve(typo).pipe(Effect.flip);
        expect(error.suggestions).toEqual(["project/desk"]);

        const reserved = yield* directory
          .resolve("reserved/desx")
          .pipe(Effect.flip);

        expect(reserved.suggestions).toEqual(["reserved/desk"]);

        for (const action of ["send", "ask", "reply"] as const) {
          const result = yield* runAction("ratking", 1000, {
            action,
            message: "hello",
            replyTo: "recalled-message",
            to: typo,
          });

          expect(result.isError).toBe(true);
          expect(result.text).toContain("did you mean project/desk?");
          expect(result.text).toContain("UnknownName");
        }

        const roles = yield* runAction("ratking", 1000, { action: "list" });

        expect(roles.text).toContain(
          "- proj (row project/desk) · Project desk"
        );
        expect(roles.text).not.toContain("did:");

        const cwd = yield* runAction("ratking", 1000, { action: "list-cwd" });
        expect(cwd.text).not.toContain("did:");
        expect(cwd.text).toContain("- project/desk");

        const filtered = yield* runAction("ratking", 1000, {
          action: "list",
          match: "absent/",
        });

        expect(filtered.text).not.toContain("- proj");

        const all = yield* runAction("ratking", 1000, {
          action: "list",
          all: true,
        });

        expect(all.text).toContain("did:web:peer.example.invalid");
      }).pipe(
        Effect.provide(
          harness(state, http, [], {
            reserved: { "reserved/desk": { did: peer.did } },
          }).pipe(Layer.provideMerge(quietSocket))
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 30_000 }
);
