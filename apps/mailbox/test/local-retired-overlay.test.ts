import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { expect } from "vitest";

import { Settings } from "../../../packages/ratking-client/src/config.ts";
import {
  Directory,
  directoryLayer,
} from "../../../packages/ratking-client/src/directory.ts";
import type { LocalRetirement } from "../../../packages/ratking-client/src/directory.ts";
import { runModel } from "./record-retired-model.ts";

type Model = Map<string, typeof LocalRetirement.Type>;

const Step = Schema.Struct({
  action: Schema.Literals(["import", "retire", "clear"]),
  name: Schema.Literals(["example/alpha", "example/beta"]),
});

class Change {
  readonly step: typeof Step.Type;
  constructor(step: typeof Step.Type) {
    this.step = step;
  }
  check() {
    return this.step.name.length > 0;
  }
  run(model: Model, directory: typeof Directory.Service) {
    return Effect.gen({ self: this }, function* apply() {
      const { action, name } = this.step;

      if (action === "import") {
        const present = model.has(name);
        const result = yield* directory.importRetired([name, name]);
        expect(result).toEqual({
          added: present ? 0 : 1,
          already: present ? 2 : 1,
        });

        if (!present) {
          model.set(name, { source: "import" });
        }
      } else if (action === "retire") {
        yield* directory.recordRetired(name, "example/next");
        model.set(name, {
          retiredAt: 0,
          source: "retire",
          successor: "example/next",
        });
      } else {
        yield* directory.clearRetired(name);
        model.delete(name);
      }

      expect(yield* directory.retired).toEqual(Object.fromEntries(model));
      expect(yield* directory.list).toEqual([]);
      expect(yield* directory.documents).toEqual([]);
    });
  }
  toString() {
    return `${this.step.action}(${this.step.name})`;
  }
}

it.effect.prop(
  "retired imports, retirements and revivals obey a model without changing identity storage",
  [Arbitrary.schema(Schema.Array(Step).check(Schema.isMaxLength(30)))],
  ([steps]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const file = `${state}/directory.json`;
      yield* fs.writeFileString(file, "{}\n");

      const directory = yield* Directory.pipe(
        Effect.provide(
          directoryLayer.pipe(
            Layer.provide(
              Layer.succeed(
                Settings,
                Settings.of({
                  askTimeoutMs: 1000,
                  didTemplate: "did:web:{agent}.example.invalid",
                  directory: file,
                  documents: [],
                  encrypt: false,
                  endpoint: "https://mailbox.example.invalid",
                  issuer: Option.none(),
                  refuse: [],
                  relays: [],
                  reserved: {},
                  secretsCommand: "unused",
                  serviceDid: "did:web:mailbox.example.invalid",
                  state,
                })
              )
            )
          )
        )
      );

      yield* runModel(
        () => ({
          model: new Map<string, typeof LocalRetirement.Type>(),
          real: directory,
        }),
        steps.map((step) => new Change(step))
      );
      expect(yield* fs.readFileString(file)).toBe("{}\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
