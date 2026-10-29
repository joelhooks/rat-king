import { DateTime, Effect, FileSystem, Schema } from "effect";

import { AgentName } from "../../packages/ratking-client/src/name.ts";

export const MAILBOX_INSTANCE = "mailbox";

export const BACKUP_OWNER = "backup";

export const DEFAULT_GRACE_MINUTES = 5;

export const BACKUP_STOP_BUDGET_MS = 25 * 60_000;

export const MAX_WINDOW_MS = 12 * 3_600_000;

export const WINDOW_MEMORY_MS = 86_400_000;

export const MaintenanceWindow = Schema.Struct({
  ended: Schema.optionalKey(Schema.Finite),
  graceMinutes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  instance: Schema.NonEmptyString,
  owner: AgentName,
  reason: Schema.NonEmptyString,
  start: Schema.Finite,
  until: Schema.Finite,
});

export type MaintenanceWindowValue = typeof MaintenanceWindow.Type;

export const MaintenanceFile = Schema.Struct({
  version: Schema.Literal(1),
  windows: Schema.Array(MaintenanceWindow),
});

export const maintenancePath = (stateDirectory: string) =>
  `${stateDirectory}/maintenance.json`;

export interface Cover {
  readonly end: number;
  readonly grace: number;
  readonly id: string;
  readonly instance: string;
  readonly owner: string;
  readonly reason: string;
  readonly recipients: readonly string[];
  readonly start: number;
  readonly until: number;
}

export const clock = (at: number) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(at)).slice(11, 16)}Z`;

export const coverEnd = (window: MaintenanceWindowValue) =>
  (window.ended ?? window.until) + window.graceMinutes * 60_000;

const declared = (window: MaintenanceWindowValue): Cover => ({
  end: coverEnd(window),
  grace: window.graceMinutes,
  id: `${window.instance}@${window.start}`,
  instance: window.instance,
  owner: window.owner,
  reason: window.reason,
  recipients: [window.owner],
  start: window.start,
  until: window.until,
});

export const backupCover = (
  backup: { readonly end: number | null; readonly start: number } | null
): Cover | undefined => {
  if (backup === null) {
    return undefined;
  }

  const deadline = backup.start + BACKUP_STOP_BUDGET_MS;

  return {
    end: backup.end === null ? deadline : Math.min(backup.end, deadline),
    grace: 0,
    id: `${MAILBOX_INSTANCE}@backup@${backup.start}`,
    instance: MAILBOX_INSTANCE,
    owner: BACKUP_OWNER,
    reason: "nightly backup stop budget",
    recipients: [],
    start: backup.start,
    until: deadline,
  };
};

export interface MaintenanceFacts {
  readonly backup?:
    | { readonly end: number | null; readonly start: number }
    | null
    | undefined;
  readonly maintenance?: readonly MaintenanceWindowValue[] | undefined;
}

export const coversOf = (facts: MaintenanceFacts, instance: string) => {
  const backup =
    instance === MAILBOX_INSTANCE
      ? backupCover(facts.backup ?? null)
      : undefined;

  return [
    ...(facts.maintenance ?? [])
      .filter((window) => window.instance === instance)
      .map(declared),
    ...(backup === undefined ? [] : [backup]),
  ];
};

export const coveringWindow = (
  facts: MaintenanceFacts,
  instance: string,
  at: number
) =>
  coversOf(facts, instance).find(
    (cover) => cover.start <= at && at <= cover.end
  );

export const overranWindow = (
  facts: MaintenanceFacts,
  instance: string,
  lastUp: number | undefined,
  now: number
) =>
  coversOf(facts, instance)
    .filter(
      (cover) =>
        cover.end < now &&
        now - cover.end < WINDOW_MEMORY_MS &&
        (lastUp ?? Number.NEGATIVE_INFINITY) < cover.end
    )
    .toSorted((a, b) => b.end - a.end)[0];

export const maintenanceEvidence = (cover: Cover) =>
  `${cover.instance}: maintenance by ${cover.owner}, ends ${clock(cover.until)}`;

export const overrunEvidence = (cover: Cover) =>
  `overran maintenance by ${cover.owner} (${cover.reason}) that ended ${clock(cover.until)}${cover.grace > 0 ? ` plus ${cover.grace} min grace` : ""}`;

export const readMaintenance = Effect.fn("Alarm.readMaintenance")(
  function* readMaintenance(stateDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const file = maintenancePath(stateDirectory);

    if (!(yield* fs.exists(file))) {
      return [];
    }

    const decoded = yield* Schema.decodeEffect(
      Schema.fromJsonString(MaintenanceFile)
    )(yield* fs.readFileString(file));

    return decoded.windows;
  }
);
