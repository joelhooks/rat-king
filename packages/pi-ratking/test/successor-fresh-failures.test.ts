import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ReaderState } from "@rat-king/ratking-client/ratking";
import { ReaderJournal } from "@rat-king/ratking-client/reader-journal";
import { Effect, FileSystem, Layer, Logger, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { harness } from "./harness.ts";
import { startReader, successorMailbox } from "./successor-fixture.ts";

for (const step of [
  "parent journal",
  "threads.open",
  "asks.reload",
  "displayed.checkpoint",
] as const) {
  it.effect.prop(
    `a successor starts fresh after ${step} fails, without inherited display state`,
    { marker: Schema.String },
    ({ marker }) =>
      Effect.gen(function* recovery() {
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

        yield* fs.writeFileString(
          file,
          JSON.stringify({
            ...saved,
            shownIds: [marker],
            shownTurns: [marker],
          })
        );
        yield* fs.makeDirectory(`${state}/asks`, { recursive: true });
        yield* fs.writeFileString(`${state}/asks/tester.json`, "[]");
        yield* fs.makeDirectory(`${state}/threads`, { recursive: true });
        yield* fs.writeFileString(`${state}/threads/tester.json`, "[]");

        const unavailable = FileSystem.makeNoop({});
        let active = true;
        let askReads = 0;

        const failing = FileSystem.makeNoop({
          ...fs,
          readFileString: (name, encoding) =>
            Effect.suspend(() => {
              if (name.endsWith("/asks/tester.json")) {
                askReads += 1;
              }

              const refused =
                (step === "parent journal" && name === file) ||
                (step === "threads.open" &&
                  name.endsWith("/threads/tester.json")) ||
                (step === "asks.reload" &&
                  name.endsWith("/asks/tester.json") &&
                  askReads === 2);

              return active && refused
                ? unavailable.readFileString(name)
                : fs.readFileString(name, encoding);
            }),
          writeFileString: (name, text, options) =>
            active &&
            step === "displayed.checkpoint" &&
            name.includes("/reader-journals/")
              ? unavailable.writeFileString(name, text)
              : fs.writeFileString(name, text, options),
        });

        const warnings: string[] = [];

        const capture = Logger.layer([
          Logger.make(({ logLevel, message }) => {
            if (
              logLevel === "Warn" &&
              String(message).startsWith("started fresh:")
            ) {
              warnings.push(String(message));
            }
          }),
        ]);

        const child = yield* startReader(
          harness(state, server.http, [], { secrets }, failing).pipe(
            Layer.provideMerge(server.socket),
            Layer.provideMerge(capture)
          ),
          {
            ...facts,
            pid: 2,
            session: "child",
            succeeds: "parent",
            successor: true,
          }
        );

        yield* TestClock.withLive(child.live.pipe(Effect.timeout("5 seconds")));
        expect(ReaderState.$is("Live")((yield* child.king.status).reader)).toBe(
          true
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`started fresh: ${step}:`);
        expect(warnings[0]).toContain("PlatformError");
        expect(server.maximum()).toBe(1);

        active = false;
        yield* child.stop;

        const fresh = yield* fs
          .readFileString(file)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(ReaderJournal))
            )
          );

        expect(fresh.session).toBe("child");
        expect(fresh.shownIds).toEqual([]);
        expect(fresh.shownTurns).toEqual([]);
        expect(warnings).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { arbitrary: { runs: 3 }, timeout: 30_000 }
  );
}
