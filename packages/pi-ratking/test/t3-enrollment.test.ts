import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Arbitrary,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Schema,
} from "effect";
import { expect } from "vitest";

import { collectFacts } from "../src/extension.ts";
import type { NameEntryValue } from "../src/name.ts";

const Row = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,31}$/u));

it.effect.prop(
  "only the enrolled T3 thread gets the recorded name, even across independent Pi sessions; siblings and forks cannot inherit it",
  [
    Arbitrary.schema(Row),
    Arbitrary.schema(Schema.String.check(Schema.isUUID(4))),
  ],
  ([row, id]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const folder = `${home}/.local/state/rats-nest/t3-seats`;
      yield* fs.makeDirectory(folder, { mode: 0o700, recursive: true });
      const name = `test-project/${row}`;
      yield* fs.writeFileString(
        `${folder}/mcp:${id}.json`,
        JSON.stringify({
          enrolledAt: "2026-01-01T00:00:00.000Z",
          lane: "proof",
          name,
          project: "test-project",
          row,
        }),
        { mode: 0o600 }
      );

      const entries: readonly NameEntryValue[] = [
        { name, session: "original", source: "env" },
      ];

      const facts = (session: string, thread: string, parent?: string) =>
        collectFacts(session, undefined, false, entries, parent, "rpc").pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  HOME: home,
                  RATKING_NAME: "other-parent",
                  RATKING_PRINT_NAME: "provider-base",
                  T3CODE_THREAD_ID: thread,
                },
              })
            )
          )
        );

      for (const session of ["original", "new-pi-process"]) {
        expect(yield* facts(session, `mcp:${id}`)).toMatchObject({
          env: Option.some(name),
          nameless: false,
          reads: true,
        });
      }

      for (const parent of [undefined, "original"]) {
        expect(yield* facts("other", `fork-${id}`, parent)).toMatchObject({
          env: Option.none(),
          nameless: true,
          reads: false,
        });
      }

      yield* fs.writeFileString(
        `${folder}/invalid.json`,
        '{"name":"bare-name"}',
        { mode: 0o600 }
      );
      expect((yield* facts("other", "invalid")).env).toEqual(Option.none());
      expect((yield* facts("other", `../t3-seats/mcp:${id}`)).env).toEqual(
        Option.none()
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 25 } }
);

it.effect.prop(
  "tui, print and ordinary rpc still use their original environment override",
  [Arbitrary.schema(Schema.Literals(["tui", "print", "rpc"]))],
  ([mode]) =>
    Effect.gen(function* proof() {
      const env = {
        RATKING_NAME: "interactive-name",
        RATKING_PRINT_NAME: "provider-base",
      };

      if (mode !== "rpc") {
        Object.assign(env, { T3CODE_THREAD_ID: "ignored-id" });
      }

      const facts = yield* collectFacts(
        "original",
        undefined,
        mode === "tui",
        [],
        undefined,
        mode
      ).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
      );

      expect(facts.env).toEqual(
        Option.some(mode === "tui" ? "interactive-name" : "provider-base")
      );
    })
);
