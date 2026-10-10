import { Console, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { shellQuote } from "../../packages/alchemy-nest/src/ssh.ts";
import { mintHostScript } from "./mint-host-script.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

export const mintHost = Effect.fn("Nest.mintHost")(
  function* mintHost(config: StageConfigValue) {
    const target = config.mintHost;

    if (
      target === undefined ||
      !target.did.startsWith("did:web:") ||
      !/^[a-z0-9_]+$/u.test(target.secretName)
    ) {
      return yield* new FleetError({
        reason: "Valid mint target configuration required",
      });
    }

    const source = new TextEncoder().encode(mintHostScript);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const command = [
      target.node,
      "--input-type=module",
      "-",
      JSON.stringify({ did: target.did, secretName: target.secretName }),
    ]
      .map(shellQuote)
      .join(" ");

    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ConnectTimeout=5",
          "--",
          target.ssh,
          command,
        ],
        { stdin: Stream.succeed(source) }
      )
    );

    const [output, code] = yield* Effect.all(
      [
        Stream.runCollect(handle.stdout.pipe(Stream.decodeText())),
        handle.exitCode,
        Stream.runDrain(handle.stderr),
      ],
      { concurrency: "unbounded" }
    );

    if (code !== 0 || output.join("").trim() !== target.did) {
      return yield* new FleetError({
        reason: "Host mint failed; values redacted",
      });
    }

    return yield* Console.log(target.did);
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new FleetError({
              reason: "Host mint timed out; verify target before retry",
            })
          ),
      }),
      Effect.mapError(
        () =>
          new FleetError({
            reason: "Host mint failed; verify target before retry",
          })
      )
    )
);
