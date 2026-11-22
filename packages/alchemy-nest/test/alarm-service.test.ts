import { NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Ref, Schema, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";

import {
  AlarmSettings,
  LaunchdAlarmSettings,
  SystemdAlarmSettings,
} from "../../../stacks/nest/alarm-config.ts";
import { alarmCheck, alarmUnit } from "../../../stacks/nest/alarm-service.ts";
import { stageDoctor } from "../../../stacks/nest/config-doctor.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";

it.prop(
  "alarm config requires one and only one supervisor on the wire",
  [LaunchdAlarmSettings, SystemdAlarmSettings],
  ([launchd, systemd]) => {
    const decode = Schema.is(AlarmSettings);
    const { launchd: launcher, ...common } = launchd;

    expect(decode(launchd)).toBe(true);
    expect(decode(systemd)).toBe(true);
    expect(decode({ ...systemd, launchd: launcher })).toBe(false);
    expect(decode(common)).toBe(false);
  }
);

it.prop(
  "the systemd unit runs the lock-owning launcher, escaping paths and preserving append logs and restart policy",
  [StageConfig, SystemdAlarmSettings, Schema.Int],
  ([base, alarm, nonce]) => {
    const basePath = `/fixture ${nonce} %i`;
    const escaped = `/fixture ${nonce} %%i`;

    const systemd = {
      ...alarm.systemd,
      errorLog: `${basePath}/error.log`,
      node: `${basePath}/node`,
      outputLog: `${basePath}/output.log`,
      path: `${basePath}/bin:/usr/bin`,
      source: `${basePath}/checkout`,
    };

    const lines = alarmUnit(
      { ...base, alarm: { ...alarm, systemd } },
      `${basePath}/config.json`
    ).split("\n");

    expect(lines).toEqual(
      expect.arrayContaining([
        `ExecStart=":${escaped}/node" "${escaped}/checkout/stacks/nest/cli.ts" alarm`,
        `Environment="RAT_KING_STAGE_CONFIG=${escaped}/config.json"`,
        `Environment="PATH=${escaped}/bin:/usr/bin"`,
        `WorkingDirectory=${escaped}/checkout`,
        `StandardOutput=append:${escaped}/output.log`,
        `StandardError=append:${escaped}/error.log`,
        "Restart=always",
        "RestartSec=60",
        `WantedBy=${systemd.scope === "system" ? "multi-user.target" : "default.target"}`,
      ])
    );
  }
);

const handle = (output: string, code: number) => {
  const stdout = Stream.succeed(new TextEncoder().encode(output));

  return ChildProcessSpawner.makeHandle({
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(1),
    stderr: Stream.empty,
    stdin: Sink.drain,
    stdout,
    unref: Effect.succeed(Effect.void),
  });
};

const supervision = Effect.fn("Fixture.supervision")(function* supervision(
  active: boolean,
  enabled: boolean
) {
  const calls = yield* Ref.make<readonly (readonly string[])[]>([]);

  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) {
      return Effect.die("unexpected pipeline");
    }

    return Ref.update(calls, (prior) => [
      ...prior,
      [command.command, ...command.args.map(String)],
    ]).pipe(
      Effect.map(() => {
        if (command.command === "/bin/launchctl") {
          return handle(
            active ? "\tstate = running\n" : "\tstate = waiting\n",
            0
          );
        }

        if (command.args.includes("is-active")) {
          return handle(active ? "active\n" : "inactive\n", active ? 0 : 3);
        }

        return handle(enabled ? "enabled\n" : "enabled-runtime\n", 0);
      })
    );
  });

  return { calls, spawner };
});

it.effect.prop(
  "alarm-check and doctor share the platform probe; systemd runtime-only enablement does not pass doctor",
  [StageConfig, AlarmSettings, Schema.Boolean, Schema.Boolean],
  ([base, alarm, active, enabled]) =>
    Effect.gen(function* verify() {
      const { calls, spawner } = yield* supervision(active, enabled);
      const { launchd, systemd } = alarm;

      const settings = { ...alarm, enabled: true };
      const config = { ...base, alarm: settings };

      const readings = { "celld.down": { status: "unknown" } };

      const { check, doctor } = yield* Effect.all({
        check: alarmCheck(settings, Effect.succeed(readings)),
        doctor: stageDoctor(config, () =>
          Effect.succeed({ reasons: [], status: "ok" as const })
        ),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
      );

      const expected =
        systemd === undefined
          ? { active, kind: "launchd" }
          : { active, enabled, kind: "systemd" };

      const scope = systemd?.scope === "system" ? "--system" : "--user";

      const commands =
        systemd === undefined
          ? [
              [
                "/bin/launchctl",
                "print",
                `gui/${process.getuid?.()}/${launchd?.label}`,
              ],
            ]
          : [
              ["/usr/bin/systemctl", scope, "is-active", "--", systemd.unit],
              ["/usr/bin/systemctl", scope, "is-enabled", "--", systemd.unit],
            ];

      const recorded = yield* Ref.get(calls);

      expect(recorded).toHaveLength(commands.length * 2);

      for (const command of commands) {
        expect(
          recorded.filter(
            (args) => JSON.stringify(args) === JSON.stringify(command)
          )
        ).toHaveLength(2);
      }

      expect(check).toEqual({ ...readings, service: expected });
      expect(doctor).toMatchObject({
        service: expected,
        status: active && (systemd === undefined || enabled) ? "ok" : "fail",
      });
    }).pipe(Effect.provide(NodePath.layer)),
  { arbitrary: { runs: 12 } }
);
