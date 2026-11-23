import { Clock, Effect, FileSystem, Option, Path } from "effect";

import { alarmSourceMetadata } from "./alarm-config.ts";
import type { AlarmSettingsValue } from "./alarm-config.ts";
import type { AlarmHeartbeat } from "./alarm-heartbeat-schema.ts";
import { maintenanceStatusRows } from "./maintenance-inbox.ts";
import { FleetError } from "./stage-config.ts";

const maxBytes = 64 * 1024;

const permissionRange = 8 ** 4;

const unavailable = () =>
  new FleetError({ reason: "Maintenance status export unavailable" });

const encodeStatus = (
  settings: AlarmSettingsValue,
  generatedAt: number,
  heartbeat: typeof AlarmHeartbeat.Type,
  rows: Effect.Success<ReturnType<typeof maintenanceStatusRows>>
) => {
  const encoder = new TextEncoder();
  let { requests, windows, truncated } = rows;

  for (;;) {
    const bytes = encoder.encode(
      `${JSON.stringify({
        ...alarmSourceMetadata(settings),
        generatedAt,
        heartbeat: {
          ageMs: Math.max(0, generatedAt - heartbeat.at),
          at: heartbeat.at,
          outcome: heartbeat.outcome,
        },
        requests,
        truncated,
        version: 1,
        windows,
      })}\n`
    );

    if (bytes.byteLength <= maxBytes) {
      return bytes;
    }

    truncated = true;

    if (requests.length > 0) {
      requests = requests.slice(0, -1);
    } else {
      windows = windows.slice(0, -1);
    }
  }
};

const statusDirectory = Effect.fn("Maintenance.statusDirectory")(
  function* statusDirectory(file: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(file);
    const owner = process.geteuid?.();
    const parent = yield* fs.lstat(directory);
    const gid = Option.getOrUndefined(parent.gid);

    if (
      owner === undefined ||
      gid === undefined ||
      parent.type !== "Directory" ||
      Option.getOrUndefined(parent.uid) !== owner ||
      parent.mode % permissionRange !== 0o2750
    ) {
      return yield* unavailable();
    }

    const previous = yield* fs.lstat(file).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed(Option.none())
      )
    );

    if (Option.isSome(previous)) {
      const item = previous.value;

      if (
        item.type !== "File" ||
        Option.getOrUndefined(item.uid) !== owner ||
        Option.getOrUndefined(item.gid) !== gid ||
        item.mode % permissionRange !== 0o640
      ) {
        return yield* unavailable();
      }
    }

    return { directory, gid };
  }
);

export const publishMaintenanceStatus = Effect.fn("Maintenance.publishStatus")(
  function* publishMaintenanceStatus(
    settings: AlarmSettingsValue,
    stateDirectory: string,
    heartbeat: typeof AlarmHeartbeat.Type
  ) {
    const file = settings.maintenanceStatusPath;

    if (file === undefined) {
      return;
    }

    const fs = yield* FileSystem.FileSystem;
    const { directory, gid } = yield* statusDirectory(file);
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* maintenanceStatusRows(stateDirectory, now);

    const temp = yield* fs.makeTempFileScoped({
      directory,
      prefix: ".alarm-status-",
    });

    yield* fs.chmod(temp, 0o600);

    const handle = yield* fs.open(temp, { flag: "w", noFollow: true });
    yield* handle.writeAll(encodeStatus(settings, now, heartbeat, rows));

    yield* handle.stat.pipe(
      Effect.filterOrFail(
        (stat) => Option.getOrUndefined(stat.gid) === gid,
        unavailable
      )
    );

    yield* fs.chmod(temp, 0o640);
    yield* handle.sync;
    yield* fs.rename(temp, file);
  },
  Effect.scoped,
  Effect.mapError(unavailable)
);
