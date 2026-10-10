import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { stageOwnedUnit } from "../../../stacks/nest/ship-unit-stage.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { textDigest } from "../src/files.ts";
import { renderUnit, unitPath } from "../src/systemd.ts";

it.effect.prop(
  "unit staging writes the new declaration before control, but never overwrites foreign drift",
  [Schema.Struct({ changed: Schema.Boolean, owned: Schema.Boolean })],
  ([input]) =>
    Effect.gen(function* ownership() {
      const fake = yield* makeFakeShell();

      const old = {
        home: "/home/example",
        name: "fixture.invalid.service",
        scope: "user" as const,
        sections: [
          {
            lines: [["ExecStart", "/opt/example/old"] as const],
            name: "Service",
          },
        ] as const,
      };

      const next = {
        ...old,
        sections: [
          {
            lines: [
              [
                "ExecStart",
                input.changed ? "/opt/example/new" : "/opt/example/old",
              ] as const,
            ],
            name: "Service",
          },
        ] as const,
      };

      const path = unitPath(old);
      yield* fake.shell.write({
        bytes: new TextEncoder().encode(renderUnit(old)),
        mode: 0o644,
        path,
      });

      const result = yield* stageOwnedUnit(fake.shell, next, {
        attr: {
          path,
          sha256: input.owned ? textDigest(renderUnit(old)) : "foreign.invalid",
        },
      }).pipe(Effect.result);

      expect(result._tag).toBe(
        input.changed && !input.owned ? "Failure" : "Success"
      );
      const actual = yield* fake.shell.read(path);
      expect(actual === undefined ? "" : new TextDecoder().decode(actual)).toBe(
        renderUnit(input.changed && input.owned ? next : old)
      );
      expect(
        (yield* fake.calls()).some((call) => call.operation === "exec")
      ).toBe(false);
    })
);
