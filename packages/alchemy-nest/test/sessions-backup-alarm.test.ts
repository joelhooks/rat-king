import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { describe, expect } from "vitest";

import {
  collectSessionsBackup,
  SESSIONS_BACKUP_MAX_AGE_MS,
  sessionsBackupReading,
} from "../../../stacks/nest/alarm-backups.ts";
import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import { alarmRecipients } from "../../../stacks/nest/alarm.ts";

const now = Date.parse("2026-10-20T12:00:00Z");

const healthy: typeof AlarmFacts.Type = {
  cacheBreaches: [],
  deploy: null,
  deployKnown: true,
  digest: "ok",
  doctor: true,
  entered: null,
  health: 200,
  measurementFailed: false,
  quarantinedHour: 0,
  readers: null,
  receipts: [],
  receiptsKnown: true,
  slots: { free: 100, max: 100 },
};

const receipt = (completedAt: string) =>
  JSON.stringify({
    bytes: 1,
    completed_at: completedAt,
    schema_version: 1,
    started_at: completedAt,
    status: "success",
  });

describe("backup.sessions-index reading", () => {
  it("is ok when not configured", () => {
    expect(sessionsBackupReading(undefined, now)).toEqual({ status: "ok" });
    expect(sessionsBackupReading("off", now)).toEqual({ status: "ok" });
  });

  it("is unknown when the files could not be read", () => {
    expect(sessionsBackupReading(null, now)).toEqual({ status: "unknown" });
  });

  it("fires on an ALARM file even with a fresh receipt", () => {
    expect(
      sessionsBackupReading(
        { alarm: "2026-10-20T08:30:00Z", completedAt: now - 1000 },
        now
      )
    ).toEqual({
      evidence: "backup ALARM file raised at 2026-10-20T08:30:00Z",
      severity: "warn",
      status: "firing",
    });
  });

  it("fires when the last success is older than eight days, and not at eight", () => {
    expect(
      sessionsBackupReading(
        { alarm: null, completedAt: now - SESSIONS_BACKUP_MAX_AGE_MS },
        now
      )
    ).toEqual({ status: "ok" });
    expect(
      sessionsBackupReading(
        { alarm: null, completedAt: now - SESSIONS_BACKUP_MAX_AGE_MS - 1 },
        now
      )
    ).toEqual({
      evidence: "last success 8 days ago",
      severity: "warn",
      status: "firing",
    });
  });

  it("fires when there is no success receipt", () => {
    expect(
      sessionsBackupReading({ alarm: null, completedAt: null }, now)
    ).toMatchObject({ evidence: "no success receipt", status: "firing" });
  });

  it("reaches observeAlarms and routes to the configured owner", () => {
    const reading = observeAlarms(
      emptySources,
      { ...healthy, sessionsBackup: { alarm: "x", completedAt: null } },
      now
    ).readings["backup.sessions-index"];

    expect(reading.status).toBe("firing");
  });
});

describe("backup.sessions-index collection", () => {
  it.effect("reads the ALARM file and the receipt's completed_at", () =>
    Effect.gen(function* collect() {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();

      const settings = {
        alarmFile: `${dir}/backup-ALARM.json`,
        receipt: `${dir}/backup-receipt.json`,
      };

      expect(yield* collectSessionsBackup(settings)).toEqual({
        alarm: null,
        completedAt: null,
      });

      yield* fs.writeFileString(
        settings.receipt,
        receipt("2026-10-18T09:12:00Z")
      );

      expect(yield* collectSessionsBackup(settings)).toEqual({
        alarm: null,
        completedAt: Date.parse("2026-10-18T09:12:00Z"),
      });

      yield* fs.writeFileString(
        settings.alarmFile,
        JSON.stringify({
          last_success: null,
          raised_at: "2026-10-20T08:30:00Z",
        })
      );

      expect(yield* collectSessionsBackup(settings)).toEqual({
        alarm: "2026-10-20T08:30:00Z",
        completedAt: Date.parse("2026-10-18T09:12:00Z"),
      });

      yield* fs.writeFileString(settings.receipt, "{not json");

      expect(yield* collectSessionsBackup(settings)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

describe("backup.sessions-index routing", () => {
  it("routes the backup warning to its configured owner", () => {
    expect(
      alarmRecipients(
        {
          broadcast: "ops/desk",
          enabled: true,
          launchd: {
            errorLog: "/e",
            label: "l",
            node: "/n",
            outputLog: "/o",
            path: "/p",
            source: "/s",
          },
          musterDesk: "muster/desk",
          notify: { directory: "/d", secret: "s" },
          owners: { "backup.sessions-index": "steward/desk" },
          page: { node: "/n", script: "/s" },
        },
        "backup.sessions-index",
        "warn"
      )
    ).toEqual(["steward/desk"]);
  });
});
