import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Result, Schema } from "effect";
import { expect } from "vitest";

import type { RestartSettings } from "../../../stacks/nest/ship-config.ts";
import {
  guardedShell,
  restartScript,
} from "../../../stacks/nest/ship-restart.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`#!/usr/bin/env python3
import json, os, pathlib, sys
path = pathlib.Path(os.environ['FIXTURE_STATE'])
value = json.loads(path.read_text())
if 'show' in sys.argv:
    if '--value' in sys.argv:
        backup = 'backup.invalid.service' in sys.argv
        print('active' if value.get('backup' if backup else 'busy') else 'inactive')
    else:
        print('ActiveState=active\nInvocationID='+value['id']+'\nRequires=store.invalid.service\nNames=cell.invalid.service alias.invalid.service\nActiveEnterTimestampMonotonic='+str(value['enter'])+'\nActiveExitTimestampMonotonic='+str(value['exit']))
elif 'restart' in sys.argv:
    value.update(id='after',exit=1000000,enter=1000000+value['duration']*1000000)
    path.write_text(json.dumps(value))
`;

const run = Effect.fn("Test.shipGuard")(function* run(
  input: {
    age: number;
    hour: number;
    start?: number;
    end?: number;
    busy: boolean;
    backup?: boolean;
    override?: string;
    unrelated?: boolean;
    duration: number;
    cascade?: boolean;
    noop?: boolean;
  },
  mode: "probe" | "restart"
) {
  const fs = yield* FileSystem.FileSystem;

  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "guard.invalid-" })
  );

  yield* fs.makeDirectory(`${root}/bin`);
  yield* fs.writeFileString(`${root}/bin/systemctl`, fixture);
  yield* fs.chmod(`${root}/bin/systemctl`, 0o700);
  yield* fs.writeFileString(
    `${root}/state.json`,
    JSON.stringify({
      backup: input.backup === true,
      busy: input.busy,
      duration: input.duration,
      enter: 1000,
      exit: 0,
      id: "before",
    })
  );
  const now = 1_577_836_800 + input.hour * 3600;
  const marker = `${root}/marker.json`;

  const seeded = JSON.stringify({
    phase: "done",
    sha: "b".repeat(40),
    started: now - input.age * 3600,
  });

  yield* fs.writeFileString(marker, seeded);

  let restart: typeof RestartSettings.Type = {
    backupUnit: "backup.invalid.service",
    lock: `${root}/backup.lock`,
    marker,
    unit: "cell.invalid.service",
    units: ["maintenance.invalid.service"],
  };

  if (input.start !== undefined && input.end !== undefined) {
    restart = {
      ...restart,
      window: { endHourUTC: input.end, startHourUTC: input.start },
    };
  }

  const base = {
    events: `${root}/events.jsonl`,
    restart,
    sha: "a".repeat(40),
  };

  const attempt =
    input.override === undefined ? base : { ...base, override: input.override };

  let unit =
    input.cascade === true ? "store.invalid.service" : "cell.invalid.service";

  if (input.unrelated === true) {
    unit = "other.invalid.service";
  }

  const prefix = `import time; time.time=lambda:${now}\n`;
  const exec = yield* localExec;

  const result = yield* exec.exec([
    "env",
    `PATH=${root}/bin:/usr/bin:/bin`,
    `FIXTURE_STATE=${root}/state.json`,
    "python3",
    "-c",
    prefix + restartScript,
    JSON.stringify(attempt),
    mode,
    "systemctl",
    "--user",
    input.noop === true ? "start" : "restart",
    unit,
  ]);

  return { ...result, marker: yield* fs.readFileString(marker), seeded };
});

const forms = [
  { args: ["restart", "cell.invalid.service"], guarded: true },
  { absolute: true, args: ["restart", "cell.invalid"], guarded: true },
  { args: ["start", "cell.invalid"], guarded: true },
  { args: ["stop", "store.invalid"], guarded: true },
  { absolute: true, args: ["try-restart", "cell.invalid"], guarded: true },
  { args: ["reload-or-restart", "cell.invalid.service"], guarded: true },
  { args: ["reload-or-try-restart", "cell.invalid"], guarded: true },
  { args: ["try-reload-or-restart", "cell.invalid"], guarded: true },
  { args: ["condrestart", "cell.invalid"], guarded: true },
  { args: ["force-reload", "cell.invalid"], guarded: true },
  { args: ["kill", "alias.invalid"], guarded: true },
  { args: ["freeze", "cell.invalid"], guarded: true },
  { args: ["reload", "cell.invalid"], guarded: true },
  { args: ["disable", "cell.invalid", "--now"], guarded: true },
  { args: ["enable", "--now", "/units/cell.invalid.service"], guarded: true },
  { args: ["mask", "--now", "cell.invalid"], guarded: true },
  { args: ["reenable", "--now", "cell.invalid"], guarded: true },
  { args: ["restart", "cell*.service"], guarded: true },
  { args: ["reload-or-restart", "--marked"], guarded: true },
  { args: ["isolate", "maintenance.invalid.target"], guarded: true },
  {
    args: ["start", "--job-mode=isolate", "maintenance.invalid.target"],
    guarded: true,
  },
  { args: ["exit"], guarded: true },
  { args: ["show", "cell.invalid"], guarded: false },
  { args: ["disable", "cell.invalid"], guarded: false },
  { args: ["restart", "other.invalid"], guarded: false },
  { args: ["restart", "cell.invalid.socket"], guarded: false },
];

it.live(
  "guards lifecycle argv at the shell and defers them while the backup runs",
  () =>
    Effect.gen(function* backupGuardArgv() {
      const fs = yield* FileSystem.FileSystem;
      const local = yield* localExec;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const program = `${root}/systemctl`;
      const state = `${root}/state.json`;
      const events = `${root}/events.jsonl`;

      yield* fs.writeFileString(program, fixture, { mode: 0o700 });
      yield* fs.writeFileString(
        state,
        JSON.stringify({
          backup: true,
          duration: 1,
          enter: 1000,
          exit: 0,
          id: "before",
        })
      );

      const shell = yield* guardedShell({
        exec: (argv) =>
          local.exec([
            "env",
            `PATH=${root}:/usr/bin:/bin`,
            `FIXTURE_STATE=${state}`,
            ...argv,
          ]),
        mkdir: () => Effect.void,
        purgeRoots: [],
        read: () => Effect.die("Unexpected file read"),
        remove: () => Effect.void,
        rmdir: () => Effect.void,
        stat: () => Effect.die("Unexpected file stat"),
        write: () => Effect.void,
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              RAT_KING_SHIP_ATTEMPT: JSON.stringify({
                events,
                restart: {
                  backupUnit: "backup.invalid.service",
                  lock: `${root}/backup.lock`,
                  marker: `${root}/marker.json`,
                  unit: "cell.invalid.service",
                  units: ["maintenance.invalid.service"],
                },
                sha: "a".repeat(40),
              }),
            })
          )
        )
      );

      for (const form of forms) {
        yield* fs.writeFileString(events, "");

        const argv = [
          form.absolute === true ? program : "systemctl",
          "--user",
          ...form.args,
        ];

        const result = yield* shell.exec(argv).pipe(Effect.result);
        const recorded = yield* fs.readFileString(events);

        expect(Result.isFailure(result), argv.join(" ")).toBe(form.guarded);
        expect(recorded.includes("backup is running"), argv.join(" ")).toBe(
          form.guarded
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const hour = Schema.Int.check(Schema.isBetween({ maximum: 23, minimum: 0 }));

it.live.prop(
  "restart policy defers, rather than fails, only outside its window, while maintenance is active or while a backup runs; a recent marker never defers",
  [
    Schema.Struct({
      age: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 0 })),
      backup: Schema.Boolean,
      busy: Schema.Boolean,
      end: hour,
      hour,
      start: hour,
    }),
  ],
  ([input]) =>
    Effect.scoped(
      Effect.gen(function* policy() {
        const result = yield* run({ ...input, duration: 0 }, "probe");

        const inWindow =
          input.start === input.end ||
          (input.start < input.end
            ? input.hour >= input.start && input.hour < input.end
            : input.hour >= input.start || input.hour < input.end);

        expect(result.code).toBe(
          inWindow && !input.busy && !input.backup ? 0 : 75
        );

        expect(result.marker).toBe(result.seeded);

        if (result.code === 75) {
          const next = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ retryAt: Schema.Number }))
          )(result.stdout);

          expect(next.retryAt).toBeGreaterThan(
            1_577_836_800 + input.hour * 3600
          );
        }
      })
    ).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 20 } }
);

it.live.prop(
  "restart receipts observe the entire target stopping-to-active interval, including dependency cascades; idempotent starts are not restarts",
  [
    Schema.Struct({
      cascade: Schema.Boolean,
      duration: Schema.Int.check(
        Schema.isBetween({ maximum: 120, minimum: 1 })
      ),
      noop: Schema.Boolean,
    }),
  ],
  ([input]) =>
    Effect.scoped(
      Effect.gen(function* observation() {
        const result = yield* run(
          { ...input, age: 12, busy: false, hour: 12 },
          "restart"
        );

        expect(result.code).toBe(0);

        const observed = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              code: Schema.Number,
              durationSeconds: Schema.Number,
              restarted: Schema.Boolean,
            })
          )
        )(result.stdout);

        expect(observed.restarted).toBe(!input.noop);
        expect(observed.durationSeconds).toBe(input.noop ? 0 : input.duration);
      })
    ).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 20 } }
);

it.live.prop(
  "a running backup refuses a restart with what failed, why and the next call; an override restarts and is recorded with its reason",
  [
    Schema.Struct({
      override: Schema.NonEmptyString,
      reason: Schema.Literals(["probe", "restart"]),
    }),
  ],
  ([input]) =>
    Effect.scoped(
      Effect.gen(function* backupRunning() {
        const base = {
          age: 12,
          backup: true,
          busy: false,
          duration: 1,
          hour: 12,
        };

        const refused = yield* run(base, input.reason);
        expect(refused.code).toBe(75);

        const deferral = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              reason: Schema.String,
              retryAt: Schema.Number,
            })
          )
        )(refused.stdout);

        expect(deferral.reason).toContain("backup is running");
        expect(deferral.reason).toContain("loses mail");
        expect(deferral.reason).toContain("RAT_KING_SHIP_RESTART_OVERRIDE");
        expect(deferral.retryAt).toBe(1_577_836_800 + 12 * 3600 + 60);
        expect(refused.marker).toBe(refused.seeded);

        const forced = yield* run(
          { ...base, override: input.override },
          input.reason
        );

        expect(forced.code).toBe(0);

        if (input.reason === "restart") {
          expect(JSON.parse(forced.stdout)).toMatchObject({
            override: input.override,
          });
        }
      })
    ).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 } }
);

it.live.prop(
  "only a ship restart of the target moves the marker: probes and unrelated commands leave it untouched",
  [Schema.Struct({ unrelated: Schema.Boolean })],
  ([input]) =>
    Effect.scoped(
      Effect.gen(function* markerOwnership() {
        const base = {
          age: 1,
          busy: false,
          duration: 1,
          hour: 12,
          unrelated: input.unrelated,
        };

        const probe = yield* run(base, "probe");
        expect(probe.marker).toBe(probe.seeded);

        const restart = yield* run(base, "restart");
        expect(restart.code).toBe(0);
        expect(restart.marker === restart.seeded).toBe(input.unrelated);
      })
    ).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 } }
);
