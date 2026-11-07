import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ReaderState } from "@rat-king/ratking-client/ratking";
import { ReaderJournal } from "@rat-king/ratking-client/reader-journal";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { expect } from "vitest";

import { harness } from "./harness.ts";
import { startReader, successorMailbox } from "./successor-fixture.ts";

for (const invalid of ["unrelated", "did", "key"] as const) {
  it.live(
    `an ${invalid} parent checkpoint leaves the successor send-only without rewriting it`,
    () =>
      Effect.gen(function* invalidCheckpoint() {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped();
        const server = successorMailbox();
        const secrets = new Map<string, string>();

        const layer = harness(state, server.http, [], { secrets }).pipe(
          Layer.provideMerge(server.socket)
        );

        const facts = {
          alive: () => false,
          env: Option.some("tester"),
          pane: Option.none<string>(),
          pid: 1,
          session: "parent",
        };

        const parent = yield* startReader(layer, facts);
        yield* parent.live;
        yield* parent.stop;
        const file = `${state}/reader-journals/tester.json`;

        const saved = yield* fs
          .readFileString(file)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(ReaderJournal))
            )
          );

        const changed = {
          ...saved,
          did: invalid === "did" ? `${saved.did}:different` : saved.did,
          keyReference:
            invalid === "key"
              ? `${saved.keyReference}:different`
              : saved.keyReference,
          session: invalid === "unrelated" ? "unrelated" : saved.session,
        };

        yield* fs.writeFileString(file, JSON.stringify(changed));

        const child = yield* startReader(layer, {
          ...facts,
          pid: 2,
          session: "child",
          succeeds: "parent",
          successor: true,
        });

        yield* child.held.pipe(Effect.timeout("5 seconds"));
        const status = yield* child.king.status;
        expect(ReaderState.$is("SendOnly")(status.reader)).toBe(true);

        if (ReaderState.$is("SendOnly")(status.reader)) {
          expect(status.reader.reason).toContain("successor not started");
        }

        expect(server.attempts).toHaveLength(2);
        expect(server.requests).toHaveLength(0);
        expect(secrets.size).toBe(1);
        expect(yield* fs.exists(`${state}/pivots/tester-2.json`)).toBe(false);

        expect(yield* fs.readFileString(file)).toBe(JSON.stringify(changed));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
}
