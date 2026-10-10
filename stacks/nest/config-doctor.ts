import { Effect, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { operatorBundle } from "../../packages/alchemy-nest/src/operator-build.ts";
import { shellQuote } from "../../packages/alchemy-nest/src/ssh.ts";
import type { StageConfigValue } from "./stage-config.ts";

export const DoctorResult = Schema.Struct({
  reasons: Schema.Array(Schema.String),
  status: Schema.Literals(["ok", "fail"]),
});

export const configDoctor = Effect.fn("Nest.configDoctor")(
  function* configDoctor(config: StageConfigValue) {
    if (config.doctor === undefined) {
      return {
        reasons: ["Pi config doctor host configuration is missing"],
        status: "fail" as const,
      };
    }

    const path = yield* Path.Path;

    const source = yield* operatorBundle(
      path.resolve(new URL("config-doctor-runner.ts", import.meta.url).pathname)
    );

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const results = yield* Effect.forEach(
      [
        { host: config.doctor.primary, label: "primary", ssh: undefined },
        {
          host: config.doctor.secondary,
          label: "secondary",
          ssh: config.doctor.secondary.ssh,
        },
      ],
      ({ label, host, ssh }) =>
        Effect.gen(function* inspectHost() {
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
                  args.map(shellQuote).join(" "),
                ];

          const handle = yield* spawner.spawn(
            ChildProcess.make(command, argv, {
              stdin: Stream.succeed(new TextEncoder().encode(source)),
            })
          );

          const [output, code] = yield* Effect.all(
            [
              Stream.runCollect(handle.stdout.pipe(Stream.decodeText())),
              handle.exitCode,
              Stream.runDrain(handle.stderr),
            ],
            { concurrency: "unbounded" }
          );

          if (code !== 0) {
            return {
              reasons: [`${label}: Pi configuration inspection failed`],
              status: "fail" as const,
            };
          }

          const facts = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(DoctorResult)
          )(output.join(""));

          return {
            reasons: facts.reasons.map((reason) => `${label}: ${reason}`),
            status: facts.status,
          };
        }).pipe(
          Effect.scoped,
          Effect.timeout("30 seconds"),
          Effect.catch(() =>
            Effect.succeed({
              reasons: [`${label}: Pi configuration inspection unavailable`],
              status: "fail" as const,
            })
          )
        )
    );

    return {
      reasons: results.flatMap((result) => result.reasons),
      status: results.some((result) => result.status === "fail")
        ? ("fail" as const)
        : ("ok" as const),
    };
  },
  (effect) =>
    effect.pipe(
      Effect.orElseSucceed(() => ({
        reasons: ["Pi configuration inspection unavailable"],
        status: "fail" as const,
      }))
    )
);
