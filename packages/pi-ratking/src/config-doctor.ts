import { Effect } from "effect";

import type { PiConfigValue } from "./config.ts";

export interface ConfigDoctorPorts<R> {
  readonly readable: (file: string) => Effect.Effect<boolean, never, R>;
  readonly executable: (program: string) => Effect.Effect<boolean, never, R>;
  readonly hostIdentity: (secret: string) => Effect.Effect<boolean, never, R>;
}

export const inspectConfig = Effect.fn("Pi.inspectConfig")(
  function* inspectConfig<R>(
    config: PiConfigValue,
    ports: ConfigDoctorPorts<R>
  ) {
    const reasons: string[] = [];

    const readable = Effect.fn("Pi.inspectReference")(function* readable(
      file: string,
      label: string
    ) {
      if (
        !(yield* ports.readable(file).pipe(Effect.orElseSucceed(() => false)))
      ) {
        reasons.push(`${label} is missing or unreadable`);
      }
    });

    for (const [index, file] of (config.documents ?? []).entries()) {
      yield* readable(file, `document ${index}`);
    }

    if (
      config.secretsCommand !== undefined &&
      !(yield* ports.executable(config.secretsCommand))
    ) {
      reasons.push("secret-store executable is unavailable");
    }

    if (config.directory !== undefined) {
      yield* readable(config.directory, "directory");
    }

    if (config.issuer !== undefined && "command" in config.issuer) {
      const [program, ...args] = config.issuer.command;

      if (
        !(yield* ports
          .executable(program)
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        reasons.push("issuer executable is unavailable");
      }

      for (const [index, arg] of args.entries()) {
        const reference =
          arg.startsWith("--") && arg.includes("=")
            ? arg.slice(arg.indexOf("=") + 1)
            : arg;

        if (
          !reference.startsWith("-") &&
          ((reference.includes("/") && !/^https?:\/\//u.test(reference)) ||
            /\.(?:sh|mjs|cjs|js|ts|py|json)$/u.test(reference))
        ) {
          yield* readable(reference, `issuer argument ${index}`);
        }
      }
    } else if (config.issuer === undefined) {
      reasons.push("identity issuer is not configured");
    } else {
      const valid = yield* ports
        .hostIdentity(config.issuer.host)
        .pipe(Effect.orElseSucceed(() => false));

      if (!valid) {
        reasons.push(
          "service issuer host identity is unavailable or malformed"
        );
      }
    }

    return {
      reasons,
      status: reasons.length === 0 ? ("ok" as const) : ("fail" as const),
    };
  }
);
