import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem } from "effect";
import { describe, expect } from "vitest";

import { SystemdAlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import { alarmCommand } from "../../../stacks/nest/alarm-service.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";
import { runCommand } from "../../ratking-client/src/process.ts";

const fixture = `
set -eu
[ "$1" = alarm-worker ]
[ "$RAT_KING_ALARM_WORKER" = locked ]
root="$(dirname "$RAT_KING_STAGE_CONFIG")"
printf '%s\\n' "$RAT_KING_STAGE_CONFIG" >> "$root/started"
if [ "$RAT_KING_STAGE_CONFIG" = "$root/hold" ]; then
  printf '%s\\n' ready > "$root/ready"
  read -r release < "$root/release"
fi
`;

describe.skipIf(process.platform !== "linux")("alarm lock", () => {
  it.live.prop(
    "the Linux launcher refuses a second worker on the same alarm.lock and admits it after the holder exits",
    [StageConfig, SystemdAlarmSettings],
    ([base, alarm]) =>
      Effect.gen(function* contention() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/stacks/nest`, { recursive: true });
        yield* fs.writeFileString(`${root}/stacks/nest/cli.ts`, fixture);

        const setup = yield* runCommand([
          "mkfifo",
          `${root}/ready`,
          `${root}/release`,
        ]);

        expect(setup.code).toBe(0);

        const config = {
          ...base,
          alarm: {
            ...alarm,
            enabled: true,
            systemd: { ...alarm.systemd, node: "/bin/sh", source: root },
          },
          runtime: { ...base.runtime, RAT_KING_STATE_DIR: root },
        };

        const hold = `${root}/hold`;
        const next = `${root}/next`;
        const owner = yield* alarmCommand(config, hold).pipe(Effect.forkScoped);

        const ready = yield* runCommand([
          "/bin/sh",
          "-c",
          'read -r ready < "$1" && printf \'%s\' "$ready"',
          "fixture",
          `${root}/ready`,
        ]);

        expect(ready.stdout).toBe("ready");

        const refused = yield* Effect.flip(alarmCommand(config, next));
        expect(refused).toMatchObject({
          reason: "Alarm owner lock unavailable or worker failed",
        });
        expect(yield* fs.readFileString(`${root}/started`)).toBe(`${hold}\n`);

        const release = yield* runCommand([
          "/bin/sh",
          "-c",
          'echo release > "$1"',
          "fixture",
          `${root}/release`,
        ]);

        expect(release.code).toBe(0);

        yield* Fiber.join(owner);
        yield* alarmCommand(config, next);
        expect(yield* fs.readFileString(`${root}/started`)).toBe(
          `${hold}\n${next}\n`
        );
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.scoped,
        Effect.provide(NodeServices.layer)
      ),
    { arbitrary: { runs: 3 } }
  );
});
