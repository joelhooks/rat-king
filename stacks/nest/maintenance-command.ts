import {
  Clock,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Result,
  Schema,
} from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { AgentName } from "../../packages/ratking-client/src/name.ts";
import {
  DEFAULT_GRACE_MINUTES,
  MAILBOX_INSTANCE,
  MAX_WINDOW_MS,
  MaintenanceFile,
  WINDOW_MEMORY_MS,
  clock,
  coverEnd,
  maintenancePath,
  readMaintenance,
} from "./alarm-maintenance.ts";
import type { MaintenanceWindowValue } from "./alarm-maintenance.ts";
import type { StageConfigValue } from "./stage-config.ts";

export const maintenanceUsage =
  'nest maintenance start --instance NAME --until HH:MMZ|+30m|ISO --owner AGENT --reason "..." [--grace-minutes 5] | end --instance NAME | list';

export type MaintenanceRequest =
  | {
      readonly action: "start";
      readonly graceMinutes: number;
      readonly instance: string;
      readonly owner: string;
      readonly reason: string;
      readonly until: string;
    }
  | { readonly action: "end"; readonly instance: string }
  | { readonly action: "list" };

const flagsOf = (argv: readonly string[]) => {
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];

    if (name === undefined || !name.startsWith("--") || value === undefined) {
      return null;
    }

    flags.set(name.slice(2), value);
  }

  return flags;
};

export const parseMaintenance = (
  argv: readonly string[]
): Result.Result<MaintenanceRequest, string> => {
  const [action, ...rest] = argv;
  const flags = flagsOf(rest);

  if (flags === null) {
    return Result.fail(
      `Flags come in --name value pairs. Usage: ${maintenanceUsage}`
    );
  }

  const allowed = (names: readonly string[]) =>
    [...flags.keys()].every((name) => names.includes(name));

  if (action === "list" && flags.size === 0) {
    return Result.succeed({ action });
  }

  const instance = flags.get("instance");

  if (action === "end" && instance !== undefined && allowed(["instance"])) {
    return Result.succeed({ action, instance });
  }

  const until = flags.get("until");
  const owner = flags.get("owner");
  const reason = flags.get("reason");
  const grace = flags.get("grace-minutes") ?? String(DEFAULT_GRACE_MINUTES);

  if (
    action === "start" &&
    allowed(["instance", "until", "owner", "reason", "grace-minutes"]) &&
    instance !== undefined &&
    until !== undefined &&
    owner !== undefined &&
    reason !== undefined &&
    reason.trim() !== ""
  ) {
    if (!/^\d{1,3}$/u.test(grace)) {
      return Result.fail("--grace-minutes must be a whole number of minutes");
    }

    return Result.succeed({
      action,
      graceMinutes: Number(grace),
      instance,
      owner,
      reason: reason.trim(),
      until,
    });
  }

  return Result.fail(`Usage: ${maintenanceUsage}`);
};

export const resolveUntil = (
  text: string,
  now: number
): Result.Result<number, string> => {
  const relative = /^\+(?<amount>\d+)(?<unit>[mh])$/u.exec(text);
  const wall = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)Z$/u.exec(text);
  let until: number;

  if (relative?.groups !== undefined) {
    until =
      now +
      Number(relative.groups.amount) *
        (relative.groups.unit === "h" ? 3_600_000 : 60_000);
  } else if (wall?.groups !== undefined) {
    const day = DateTime.formatIso(DateTime.makeUnsafe(now)).slice(0, 10);

    const today = DateTime.toEpochMillis(
      DateTime.makeUnsafe(
        `${day}T${wall.groups.hour}:${wall.groups.minute}:00.000Z`
      )
    );

    until = today > now ? today : today + 86_400_000;
  } else if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) {
    const parsed = Option.getOrUndefined(DateTime.make(text));

    if (parsed === undefined) {
      return Result.fail(`Unreadable --until ${text}`);
    }

    until = DateTime.toEpochMillis(parsed);
  } else {
    return Result.fail(
      `--until takes HH:MMZ, +30m, +2h or an ISO time with a zone, not ${text}`
    );
  }

  if (until <= now) {
    return Result.fail(`--until ${text} is already past`);
  }

  if (until - now > MAX_WINDOW_MS) {
    return Result.fail(
      `--until ${text} is more than 12 hours away; a long window would hide a real outage. Declare a nearer end and start a new window if the work runs on`
    );
  }

  return Result.succeed(until);
};

const open = (window: MaintenanceWindowValue, now: number) =>
  window.ended === undefined && coverEnd(window) >= now;

const remembered = (windows: readonly MaintenanceWindowValue[], now: number) =>
  windows.filter((window) => now - coverEnd(window) < WINDOW_MEMORY_MS);

export const startWindow = (
  windows: readonly MaintenanceWindowValue[],
  window: MaintenanceWindowValue,
  now: number
): MaintenanceWindowValue[] => [
  ...remembered(windows, now).map((item) =>
    item.instance === window.instance && open(item, now)
      ? { ...item, ended: now }
      : item
  ),
  window,
];

export const endWindow = (
  windows: readonly MaintenanceWindowValue[],
  instance: string,
  now: number
): MaintenanceWindowValue[] | undefined => {
  const kept = remembered(windows, now);

  if (!kept.some((item) => item.instance === instance && open(item, now))) {
    return undefined;
  }

  return kept.map((item) =>
    item.instance === instance && open(item, now)
      ? { ...item, ended: now }
      : item
  );
};

const describe = (window: MaintenanceWindowValue, now: number) =>
  `${window.instance}: ${open(window, now) ? "open" : "closed"}, owner ${window.owner}, ${window.reason}, ${clock(window.start)} to ${clock(window.until)}${window.ended === undefined ? "" : `, ended ${clock(window.ended)}`}, grace ${window.graceMinutes} min`;

const writeWindows = Effect.fn("Maintenance.write")(function* writeWindows(
  directory: string,
  windows: readonly MaintenanceWindowValue[]
) {
  const fs = yield* FileSystem.FileSystem;
  const file = maintenancePath(directory);
  const temp = `${file}.tmp`;

  const text = yield* Schema.encodeEffect(
    Schema.fromJsonString(MaintenanceFile)
  )({ version: 1, windows });

  yield* Effect.scoped(
    Effect.gen(function* persist() {
      const handle = yield* fs.open(temp, { flag: "w", mode: 0o600 });
      yield* handle.writeAll(new TextEncoder().encode(`${text}\n`));
      yield* handle.sync;
    })
  );
  yield* fs.rename(temp, file);
});

export const runMaintenance = Effect.fn("Maintenance.run")(
  function* runMaintenance(
    directory: string,
    instances: readonly string[],
    argv: readonly string[]
  ) {
    const parsed = parseMaintenance(argv);

    if (Result.isFailure(parsed)) {
      return yield* refuse(parsed.failure);
    }

    const request = parsed.success;

    const now = yield* Clock.currentTimeMillis;

    const windows = yield* readMaintenance(directory).pipe(
      Effect.mapError(() =>
        refuse(
          `Unreadable ${maintenancePath(directory)}; inspect it before declaring a window`
        )
      )
    );

    if (request.action === "list") {
      const lines = remembered(windows, now).map((window) =>
        describe(window, now)
      );

      return yield* Console.log(
        lines.length === 0 ? "No maintenance windows" : lines.join("\n")
      );
    }

    const known = [MAILBOX_INSTANCE, ...instances];

    if (!known.includes(request.instance)) {
      return yield* refuse(
        `Unknown instance ${request.instance}; a window covers only a named instance. Known: ${known.join(", ")}`
      );
    }

    if (request.action === "end") {
      const next = endWindow(windows, request.instance, now);

      if (next === undefined) {
        return yield* refuse(`No open window for ${request.instance}`);
      }

      yield* writeWindows(directory, next);

      return yield* Console.log(
        `Ended maintenance for ${request.instance} at ${clock(now)}; it alarms as usual if still down after ${clock(now + (next.findLast((item) => item.instance === request.instance)?.graceMinutes ?? 0) * 60_000)}`
      );
    }

    const owner = yield* Schema.decodeUnknownEffect(AgentName)(
      request.owner
    ).pipe(
      Effect.mapError(() =>
        refuse(`--owner ${request.owner} is not a Rat King agent name`)
      )
    );

    const resolved = resolveUntil(request.until, now);

    if (Result.isFailure(resolved)) {
      return yield* refuse(resolved.failure);
    }

    const until = resolved.success;

    const window: MaintenanceWindowValue = {
      graceMinutes: request.graceMinutes,
      instance: request.instance,
      owner,
      reason: request.reason,
      start: now,
      until,
    };

    yield* writeWindows(directory, startWindow(windows, window, now));

    return yield* Console.log(
      `Declared maintenance for ${window.instance} by ${owner} until ${clock(until)} (${DateTime.formatIso(DateTime.makeUnsafe(until))}), grace ${window.graceMinutes} min`
    );
  }
);

export const maintenanceCommand = (
  config: StageConfigValue,
  argv: readonly string[]
) =>
  runMaintenance(
    config.runtime.RAT_KING_STATE_DIR,
    (config.alarm?.instances ?? []).map((instance) => instance.name),
    argv
  );
