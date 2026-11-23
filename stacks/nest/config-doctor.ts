import { Effect, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { awaitModule } from "../../packages/alchemy-nest/src/late-module.ts";
import { shellQuote } from "../../packages/alchemy-nest/src/ssh.ts";
import { readCredentialEnvironment } from "../../packages/ratking-client/src/systemd-credentials.ts";
import { alarmServiceDoctor } from "./alarm-service.ts";
import {
  decodeInspection,
  inspectionDeadline,
  retryDoctorInspection,
} from "./config-doctor-inspection.ts";
import type { StageConfigValue } from "./stage-config.ts";

export { DoctorResult } from "./config-doctor-inspection.ts";

export const configDoctor = Effect.fn("Nest.configDoctor")(
  function* configDoctor(config: StageConfigValue) {
    if (config.doctor === undefined) {
      return {
        reasons: ["Pi config doctor host configuration is missing"],
        status: "fail" as const,
      };
    }

    const path = yield* Path.Path;

    const { operatorBundle } = yield* Effect.suspend(() =>
      awaitModule(
        import("../../packages/alchemy-nest/src/operator-build.ts"),
        "Operator bundle module unavailable"
      )
    );

    const source = yield* operatorBundle(
      path.resolve(new URL("config-doctor-runner.ts", import.meta.url).pathname)
    );

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const credentialEnv = yield* readCredentialEnvironment;

    const { primary, secondary } = config.doctor;

    const local = { host: primary, label: "primary", ssh: undefined };

    const hosts =
      secondary === undefined
        ? [local]
        : [local, { host: secondary, label: "secondary", ssh: secondary.ssh }];

    const inspect = ({ label, host, ssh }: (typeof hosts)[number]) => {
      let diagnostic = "";

      return Effect.gen(function* inspectHost() {
        const args = [
          host.node ?? "node",
          "--input-type=module",
          "-",
          host.config ?? "",
        ];

        const remote = ssh !== undefined;
        const command = remote ? "ssh" : (host.node ?? "node");

        const argv =
          ssh === undefined
            ? args.slice(1)
            : [
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "ConnectTimeout=5",
                "--",
                ssh,
                (credentialEnv.RAT_KING_SECRET_SOURCE === undefined
                  ? args
                  : [
                      "env",
                      "-u",
                      "CREDENTIALS_DIRECTORY",
                      `RAT_KING_SECRET_SOURCE=${credentialEnv.RAT_KING_SECRET_SOURCE}`,
                      ...args,
                    ]
                )
                  .map(shellQuote)
                  .join(" "),
              ];

        const attempt = Effect.fn("Nest.inspectAttempt")(function* attempt(
          solo: boolean
        ) {
          diagnostic = "";

          const handle = yield* spawner.spawn(
            ChildProcess.make(
              command,
              solo ? ["-o", "ControlPath=none", ...argv] : argv,
              {
                env: remote ? {} : credentialEnv,
                extendEnv: true,
                stdin: Stream.succeed(new TextEncoder().encode(source)),
              }
            )
          );

          const [output, code, stderr] = yield* Effect.all(
            [
              Stream.runCollect(handle.stdout.pipe(Stream.decodeText())),
              handle.exitCode,
              Stream.runForEach(
                handle.stderr.pipe(Stream.decodeText()),
                (chunk) =>
                  Effect.sync(() => {
                    diagnostic = (diagnostic + chunk).slice(-65_536);
                  })
              ).pipe(Effect.map(() => diagnostic)),
            ],
            { concurrency: "unbounded" }
          );

          return { code: Number(code), output: output.join(""), stderr };
        });

        const result = yield* retryDoctorInspection(remote, attempt);

        return yield* decodeInspection(
          label,
          remote,
          result.output,
          result.code,
          result.stderr
        );
      }).pipe(Effect.scoped, (inspection) =>
        inspectionDeadline(label, inspection, () => diagnostic)
      );
    };

    const results = yield* Effect.all(hosts.map(inspect));
    let status: "ok" | "warn" | "fail" = "ok";

    if (results.some((result) => result.status === "fail")) {
      status = "fail";
    } else if (results.some((result) => result.status === "warn")) {
      status = "warn";
    }

    return {
      reasons: results.flatMap((result) => result.reasons),
      status,
    };
  },
  (effect) =>
    effect.pipe(
      Effect.orElseSucceed(() => ({
        reasons: ["Pi configuration inspection unavailable"],
        status: "warn" as const,
      }))
    )
);

export const stageDoctor = Effect.fn("Nest.stageDoctor")(function* stageDoctor(
  config: StageConfigValue,
  inspect: typeof configDoctor = configDoctor
) {
  const settings = config.alarm;

  if (settings === undefined) {
    return yield* inspect(config);
  }

  const { pi, alarm } = yield* Effect.all(
    { alarm: alarmServiceDoctor(settings), pi: inspect(config) },
    { concurrency: "unbounded" }
  );

  return {
    reasons: [...pi.reasons, ...alarm.reasons],
    service: alarm.service,
    status:
      pi.status === "ok" || alarm.status === "fail" ? alarm.status : pi.status,
  };
});
