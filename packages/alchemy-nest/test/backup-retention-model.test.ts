import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, DateTime, Effect, FileSystem, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { backupRetentionScript } from "../src/backup-retention-script.ts";
import type { Interface } from "../src/host-shell.ts";
import { localExec } from "../src/local-exec.ts";

const apply = String.raw`
import contextlib, io, json, pathlib, sys
exec(sys.argv[1])
root = pathlib.Path(sys.argv[2])
for name in json.loads(sys.argv[3]):
    path = root/name
    path.mkdir()
    (path/'mailbox.tar.gz').write_bytes(b'archive')
    (path/'manifest.json').write_text(json.dumps({'format': 4, 'sha256': {'mailbox.tar.gz': 'a'*64}}))
out = io.StringIO()
with contextlib.redirect_stdout(out):
    retention_run(root, json.loads(sys.argv[3])[-1])
alarm = 'BACKUP_RETENTION_ALARM' in out.getvalue()
print(json.dumps({'alarm': alarm, 'names': sorted(path.name for path in root.iterdir()), 'log': out.getvalue()}))
`;

interface Model {
  day: number;
  names: string[];
}

interface Real {
  root: string;
  shell: Pick<Interface, "exec">;
}

const week = (name: string) => {
  const date = DateTime.makeUnsafe(
    `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T00:00:00Z`
  );

  return DateTime.formatIsoDate(
    DateTime.add(date, {
      days: 4 - (DateTime.getPartUtc(date, "weekDay") || 7),
    })
  );
};

const command = (count: number, stride: number): AsyncCommand<Model, Real> => ({
  check: () => true,
  run: Effect.fn("Test.retention.model.publishAndRetain")(
    function* run(model: Model, real: Real) {
      const added: string[] = [];

      for (let index = 0; index < count; index += 1) {
        model.day += stride;

        const date = DateTime.add(DateTime.makeUnsafe("2025-12-15T00:00:00Z"), {
          days: model.day,
        });

        added.push(
          `${DateTime.formatIsoDate(date).replaceAll("-", "")}T100000.000000Z-${"a".repeat(32)}`
        );
      }

      model.names.push(...added);

      const keep = model.names.filter((name, index, all) => {
        const later = all.slice(index + 1);
        const laterWeeks = new Set(later.map(week));

        return (
          index === 0 ||
          later.length < 7 ||
          (!laterWeeks.has(week(name)) && laterWeeks.size < 4)
        );
      });

      const removals = model.names.filter((name) => !keep.includes(name));
      const alarm = removals.length > 3;

      if (!alarm && model.names.length >= 8) {
        model.names = keep;
      }

      const result = yield* real.shell.exec([
        "python3",
        "-c",
        apply,
        backupRetentionScript,
        real.root,
        JSON.stringify(added),
      ]);

      expect(result.code).toBe(0);

      const observed = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            alarm: Schema.Boolean,
            log: Schema.String,
            names: Schema.Array(Schema.String),
          })
        )
      )(result.stdout);

      expect(observed.alarm).toBe(alarm);
      expect(observed.names).toEqual(model.names);
      expect(observed.names).toContain(added.at(-1));
      expect(
        observed.log
          .split("\n")
          .filter((line) => line.startsWith("BACKUP_RETENTION_REMOVED "))
          .map((line) => line.split(" ")[1])
      ).toEqual(alarm ? [] : removals);

      if (alarm) {
        expect(observed.log).not.toContain("BACKUP_RETENTION_REMOVED");
      }
    },
    // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests, typescript/promise-function-async -- fast-check owns the async command boundary.
    (effect) => Effect.runPromise(effect)
  ),
  toString: () => `Publish(${count}, stride=${stride})ThenRetain`,
});

it.effect.prop(
  "successive confirmed backup batches match a small retention model after every command, including the three-removal circuit breaker",
  {
    steps: Arbitrary.schema(
      Schema.Array(
        Schema.Struct({
          count: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
          stride: Schema.Int.check(
            Schema.isBetween({ maximum: 4, minimum: 1 })
          ),
        })
      ).check(Schema.isMinLength(1), Schema.isMaxLength(12))
    ),
  },
  ({ steps }) =>
    Effect.gen(function* modelContract() {
      const fs = yield* FileSystem.FileSystem;

      const root = yield* fs
        .makeTempDirectoryScoped()
        .pipe(Effect.flatMap((path) => fs.realPath(path)));

      const shell = yield* localExec;
      yield* Effect.promise(
        asyncModelRun.bind(
          undefined,
          () => ({
            model: { day: 0, names: [] } satisfies Model,
            real: { root, shell },
          }),
          steps.map(({ count, stride }) => command(count, stride))
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 30 } }
);
