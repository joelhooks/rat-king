import { Effect } from "effect";

import { HostError } from "../../packages/alchemy-nest/src/host-shell.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";

export const maintenanceTimers = [
  "rat-king-storage-grow.timer",
  "rat-king-storage-retention.timer",
] as const;

export const backupControl = Effect.fn("Nest.backupControl")(
  function* control(
    shell: Pick<Interface, "exec">,
    action: string,
    unit: string
  ) {
    const result = yield* shell
      .exec(["systemctl", "--user", action, unit])
      .pipe(
        Effect.mapError(
          () =>
            new HostError({
              operation: `systemctl ${action} ${unit}`,
              reason: `unit=${unit} action=${action} exit=unavailable job=unknown`,
            })
        )
      );

    if (result.code !== 0) {
      const job =
        /\b(?:canceled|cancelled|dependency|timeout|failed|skipped)\b/iu
          .exec(result.stderr ?? "")?.[0]
          ?.toLowerCase() ?? "unknown";

      const reason = `unit=${unit} action=${action} exit=${result.code} job=${job}`;

      return yield* new HostError({
        operation: `systemctl ${action} ${unit}`,
        reason,
      });
    }

    return result.stdout;
  },
  (effect) =>
    effect.pipe(
      Effect.tapError((failure) =>
        Effect.logError("BACKUP_UNIT_FAILED", failure.reason)
      )
    )
);

export const restartMaintenanceTimers = (shell: Pick<Interface, "exec">) =>
  backupControl(shell, "start", maintenanceTimers[0]).pipe(
    Effect.ensuring(
      backupControl(shell, "start", maintenanceTimers[1]).pipe(Effect.orDie)
    ),
    Effect.orDie,
    Effect.uninterruptible
  );
