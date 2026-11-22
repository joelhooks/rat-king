import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { runCommand } from "../../packages/ratking-client/src/process.ts";
import type { AlarmSettingsValue } from "./alarm-config.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const string = (value: string) => `<string>${xml(value)}</string>`;

const alarmScript = (source: string) => `${source}/stacks/nest/cli.ts`;

export const alarmPlist = (config: StageConfigValue, configPath: string) => {
  const launch = config.alarm?.launchd;

  if (launch === undefined) {
    return "";
  }

  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key>${string(launch.label)}<key>ProgramArguments</key><array>${[launch.node, alarmScript(launch.source), "alarm"].map(string).join("")}</array><key>EnvironmentVariables</key><dict><key>RAT_KING_STAGE_CONFIG</key>${string(configPath)}<key>PATH</key>${string(launch.path)}</dict><key>WorkingDirectory</key>${string(launch.source)}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer><key>StandardOutPath</key>${string(launch.outputLog)}<key>StandardErrorPath</key>${string(launch.errorLog)}</dict></plist>\n`;
};

const escapeSpecifiers = (value: string) => value.replaceAll("%", "%%");

const unitWord = (value: string) => {
  const escaped = escapeSpecifiers(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll(/\p{Cc}/gu, (char) => {
      const code = char.codePointAt(0) ?? 0;

      return code <= 127 ? `\\x${code.toString(16).padStart(2, "0")}` : char;
    });

  return `"${escaped}"`;
};

export const alarmUnit = (config: StageConfigValue, configPath: string) => {
  const launch = config.alarm?.systemd;

  if (launch === undefined) {
    return "";
  }

  return `[Unit]
Description=Rat King fleet alarm

[Service]
Type=exec
ExecStart=${unitWord(`:${launch.node}`)} ${unitWord(alarmScript(launch.source))} alarm
Environment=${unitWord(`RAT_KING_STAGE_CONFIG=${configPath}`)}
Environment=${unitWord(`PATH=${launch.path}`)}
WorkingDirectory=${escapeSpecifiers(launch.source)}
StandardOutput=append:${escapeSpecifiers(launch.outputLog)}
StandardError=append:${escapeSpecifiers(launch.errorLog)}
Restart=always
RestartSec=60

[Install]
WantedBy=${launch.scope === "system" ? "multi-user.target" : "default.target"}
`;
};

export const alarmCommand = Effect.fn("Alarm.command")(function* alarmCommand(
  config: StageConfigValue,
  configPath: string
) {
  if (config.alarm?.enabled !== true) {
    return yield* new FleetError({ reason: "Alarms are disabled" });
  }

  const launch = config.alarm.systemd ?? config.alarm.launchd;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const lock = path.join(
    yield* fs.realPath(config.runtime.RAT_KING_STATE_DIR),
    "alarm.lock"
  );

  const [command, flags] =
    config.alarm.systemd === undefined
      ? ["/usr/bin/lockf", ["-k", "-t", "0"]]
      : ["/usr/bin/flock", ["--nonblock", "--no-fork", "--"]];

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const child = yield* spawner.spawn(
    ChildProcess.make(
      command,
      [...flags, lock, launch.node, alarmScript(launch.source), "alarm-worker"],
      {
        env: {
          RAT_KING_ALARM_WORKER: "locked",
          RAT_KING_STAGE_CONFIG: configPath,
        },
        extendEnv: true,
        stderr: "inherit",
        stdin: "ignore",
        stdout: "inherit",
      }
    )
  );

  if ((yield* child.exitCode) !== 0) {
    return yield* new FleetError({
      reason: "Alarm owner lock unavailable or worker failed",
    });
  }

  return yield* Effect.void;
}, Effect.scoped);

const probe = (argv: readonly [string, ...string[]]) =>
  runCommand(argv).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => null)
  );

const systemdState = (
  result: { readonly code: number; readonly stdout: string } | null,
  expected: string
) => {
  const state = result?.stdout.trim();

  return state === undefined || state === ""
    ? null
    : result?.code === 0 && state === expected;
};

export const checkAlarmService = Effect.fn("Alarm.checkService")(
  function* checkAlarmService(settings: AlarmSettingsValue) {
    if (settings.systemd !== undefined) {
      const { scope, unit } = settings.systemd;

      const systemctl = (action: string) =>
        probe([
          "/usr/bin/systemctl",
          scope === "system" ? "--system" : "--user",
          action,
          "--",
          unit,
        ]);

      const { active, enabled } = yield* Effect.all(
        { active: systemctl("is-active"), enabled: systemctl("is-enabled") },
        { concurrency: "unbounded" }
      );

      return {
        active: systemdState(active, "active"),
        enabled: systemdState(enabled, "enabled"),
        kind: "systemd" as const,
      };
    }

    const uid = process.getuid?.();

    const result =
      uid === undefined
        ? null
        : yield* probe([
            "/bin/launchctl",
            "print",
            `gui/${uid}/${settings.launchd.label}`,
          ]);

    return {
      active:
        result === null
          ? null
          : result.code === 0 &&
            /^\s*state = running\s*$/mu.test(result.stdout),
      kind: "launchd" as const,
    };
  }
);

export const alarmCheck = Effect.fn("Alarm.check")(function* alarmCheck<
  A extends object,
  E,
  R,
>(settings: AlarmSettingsValue, readings: Effect.Effect<A, E, R>) {
  const observed = yield* Effect.all(
    { readings, service: checkAlarmService(settings) },
    { concurrency: "unbounded" }
  );

  return { ...observed.readings, service: observed.service };
});

export const alarmServiceDoctor = Effect.fn("Alarm.serviceDoctor")(
  function* alarmServiceDoctor(settings: AlarmSettingsValue) {
    const service = yield* checkAlarmService(settings);
    const reasons: string[] = [];
    let status: "ok" | "warn" | "fail" = "ok";

    if (settings.enabled) {
      const checks =
        service.kind === "systemd"
          ? ([
              ["active", service.active],
              ["enabled", service.enabled],
            ] as const)
          : ([["active", service.active]] as const);

      for (const [check, observed] of checks) {
        if (observed === false) {
          status = "fail";
          reasons.push(`Alarm ${service.kind} service is not ${check}`);
        } else if (observed === null) {
          if (status === "ok") {
            status = "warn";
          }

          reasons.push(
            `Alarm ${service.kind} service ${check} check unavailable`
          );
        }
      }
    }

    return { reasons, service, status };
  }
);
