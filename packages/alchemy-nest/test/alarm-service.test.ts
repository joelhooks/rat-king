import { NodePath, NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Ref,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";

import {
  AlarmSettings,
  LaunchdAlarmSettings,
  SystemdAlarmSettings,
} from "../../../stacks/nest/alarm-config.ts";
import {
  alarmCheck,
  alarmUnit,
  stageAlarmCheck,
} from "../../../stacks/nest/alarm-service.ts";
import {
  configDoctor,
  stageDoctor,
} from "../../../stacks/nest/config-doctor.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";
import { runCommand } from "../../ratking-client/src/process.ts";

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
        ...(systemd.scope === "system"
          ? [`User=${systemd.user}`, `Group=${systemd.group}`]
          : []),
        `WantedBy=${systemd.scope === "system" ? "multi-user.target" : "default.target"}`,
      ])
    );
  }
);

it.prop(
  "a system alarm rejects absent or root service accounts before rendering",
  [SystemdAlarmSettings],
  ([alarm]) => {
    const { user: _user, group: _group, ...unit } = alarm.systemd;
    const invalid = { ...alarm, systemd: { ...unit, scope: "system" } };

    expect(Schema.is(AlarmSettings)(invalid)).toBe(false);
    expect(
      Schema.is(AlarmSettings)({
        ...invalid,
        systemd: { ...invalid.systemd, group: "service", user: "root" },
      })
    ).toBe(false);
    expect(
      Schema.is(AlarmSettings)({
        ...invalid,
        systemd: { ...invalid.systemd, group: "root", user: "service" },
      })
    ).toBe(false);
    expect(
      Schema.is(AlarmSettings)({
        ...invalid,
        systemd: { ...invalid.systemd, group: "service\n", user: "service" },
      })
    ).toBe(false);
  }
);

it.effect.skipIf(process.platform !== "linux")(
  "Linux systemd-analyze verifies the rendered system alarm unit",
  (context) =>
    Effect.gen(function* verify() {
      const fs = yield* FileSystem.FileSystem;
      const analyze = "/usr/bin/systemd-analyze";

      if (!(yield* fs.exists(analyze))) {
        context.skip("systemd-analyze is not installed");

        return yield* Effect.void;
      }

      const dir = yield* fs.makeTempDirectoryScoped();

      const alarm = yield* Schema.decodeEffect(SystemdAlarmSettings)({
        broadcast: "fixture",
        enabled: true,
        musterDesk: "fixture",
        notify: { directory: dir, secret: "fixture" },
        owners: {},
        page: { node: process.execPath, script: dir },
        systemd: {
          errorLog: `${dir}/err.log`,
          group: "users",
          node: process.execPath,
          outputLog: `${dir}/out.log`,
          path: "/usr/bin",
          scope: "system",
          source: dir,
          unit: "fixture-alarm.service",
          user: "nobody",
        },
      });

      const file = `${dir}/fixture-alarm.service`;
      yield* fs.writeFileString(
        file,
        alarmUnit({ alarm }, `${dir}/stage.json`)
      );
      expect(
        (yield* runCommand([analyze, "verify", "--recursive-errors=no", file]))
          .code
      ).toBe(0);

      return yield* Effect.void;
    }).pipe(Effect.provide(NodeServices.layer))
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

      const checked = { ...readings, service: expected };

      expect(check).toEqual(
        settings.page === undefined
          ? { ...checked, page: "not configured" }
          : checked
      );
      expect(doctor).toMatchObject({
        service: expected,
        status: active && (systemd === undefined || enabled) ? "ok" : "fail",
      });
    }).pipe(Effect.provide(NodePath.layer)),
  { arbitrary: { runs: 12 } }
);

it.effect.prop(
  "alarm-check pins absent observer labels and distinguishes a missing primary",
  [StageConfig, LaunchdAlarmSettings],
  ([base, settings]) =>
    Effect.gen(function* omission() {
      const { spawner } = yield* supervision(true, true);
      const { doctor, ...stage } = base;
      const { page: _page, ...alarm } = settings;
      const config = { ...stage, alarm, comms: { local: stage.comms.local } };
      const readings = Effect.succeed({ "celld.down": { status: "unknown" } });

      const checks = yield* Effect.all({
        missing: stageAlarmCheck(config, readings),
        primaryOnly: stageAlarmCheck(
          { ...config, doctor: { primary: doctor?.primary ?? {} } },
          readings
        ),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
      );

      const common = {
        "celld.down": { status: "unknown" },
        "comms.remote": "not configured",
        page: "not configured",
        service: { active: true, kind: "launchd" },
      };

      expect(checks.primaryOnly).toEqual({
        ...common,
        "doctor.secondary": "not configured",
      });
      expect(checks.missing).toEqual({
        ...common,
        "doctor.primary": "missing",
      });
    }).pipe(Effect.provide(NodePath.layer)),
  { arbitrary: { runs: 3 } }
);

it.effect.prop(
  "doctor skips an omitted secondary; when configured it forwards the mount only to the local probe",
  [StageConfig, Schema.Boolean],
  ([base, withSecondary]) =>
    Effect.gen(function* verify() {
      const commands: ChildProcess.StandardCommand[] = [];

      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die("Unexpected pipeline");
        }

        commands.push(command);

        return Effect.succeed(handle('{"status":"ok","reasons":[]}', 0));
      });

      const primary = { config: "/fixture/local-config.json", node: "node" };

      const secondary = {
        config: "/fixture/remote-config.json",
        ssh: "second.invalid",
      };

      const doctor = withSecondary ? { primary, secondary } : { primary };

      const result = yield* configDoctor({ ...base, doctor }).pipe(
        Effect.provide([
          NodePath.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CREDENTIALS_DIRECTORY: "/fixture/mount",
              RAT_KING_SECRET_SOURCE: "systemd",
            })
          ),
        ]),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
      );

      expect(result).toEqual({ reasons: [], status: "ok" });
      expect(commands.map(({ command }) => command)).toEqual(
        withSecondary ? ["node", "ssh"] : ["node"]
      );
      expect(
        commands.find((command) => command.command === "node")?.options.env
      ).toEqual({
        CREDENTIALS_DIRECTORY: "/fixture/mount",
        RAT_KING_SECRET_SOURCE: "systemd",
      });

      if (withSecondary) {
        const remote = commands.find((command) => command.command === "ssh");

        expect(remote?.options.env).toEqual({});
        expect(remote?.args.at(-1)).toContain(
          "'env' '-u' 'CREDENTIALS_DIRECTORY' 'RAT_KING_SECRET_SOURCE=systemd'"
        );
        expect(remote?.args.at(-1)).not.toContain("/fixture/mount");
      }
    }),
  { arbitrary: { runs: 2 } }
);
