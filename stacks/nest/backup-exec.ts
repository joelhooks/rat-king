import { Effect } from "effect";

import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import { localExec } from "../../packages/alchemy-nest/src/local-exec.ts";

export const captureCommand = Effect.fn("Nest.backup.captureCommand")(
  function* capture(shell: Pick<Interface, "exec">, argv: readonly string[]) {
    const result = yield* shell.exec([
      "sh",
      "-c",
      'exec "$@" 2>&1',
      "backup-control",
      ...argv,
    ]);

    return { ...result, stderr: result.stdout };
  }
);

export const backupExec = localExec.pipe(
  Effect.map((shell) => ({
    exec: Effect.fn("Nest.backup.exec")((argv: readonly string[]) =>
      argv[0] === "systemctl" ? captureCommand(shell, argv) : shell.exec(argv)
    ),
  }))
);
