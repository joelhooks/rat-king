import { Duration } from "effect";

export const precopyMaxLimit = Duration.minutes(90);

export const armSlack = Duration.minutes(20);

export const stopRestartLimit = Duration.minutes(10);

export const backupStopBudgetMs =
  Duration.toMillis(precopyMaxLimit) +
  Duration.toMillis(armSlack) +
  Duration.toMillis(stopRestartLimit);

export const precopyRequestedMinutes = (bytes: number) =>
  25 + Math.max(0, Math.ceil(bytes / 1_073_741_824) - 100);

export const precopyLimit = (bytes: number) =>
  Duration.minutes(
    Math.min(
      Duration.toMinutes(precopyMaxLimit),
      precopyRequestedMinutes(bytes)
    )
  );

export const precopyAlarmSeconds = (limit: Duration.Duration) =>
  Duration.toSeconds(limit) - 10;
