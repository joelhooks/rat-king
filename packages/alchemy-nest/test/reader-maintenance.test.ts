import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";

import { READER_RECOVERY_GRACE_MS } from "../../../stacks/nest/alarm-reader-windows.ts";
import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import { crashedReader } from "../../../stacks/nest/turn-crash-record.ts";
import {
  READER_STUCK_MS,
  ReaderHeartbeat,
} from "../../ratking-client/src/reader-health.ts";

it.effect.prop(
  "backup, declared maintenance and receipt windows suppress only window-related reader pages and synthetic crashes through grace, then expose both lapse and acquiring failures",
  {
    acquiring: Schema.Boolean,
    closed: Schema.Boolean,
    kind: Schema.Literals(["backup", "maintenance", "receipt", "other"]),
    span: Schema.Int.check(
      Schema.isBetween({ maximum: 600_000, minimum: 20_000 })
    ),
  },
  ({ acquiring, closed, kind, span }) =>
    Effect.sync(() => {
      const start = 1_000_000;
      const end = start + span;

      const window: Pick<
        typeof AlarmFacts.Type,
        "backup" | "maintenance" | "windows"
      > = {
        ...(kind === "backup"
          ? { backup: { end: closed ? end : null, start } }
          : undefined),
        ...(kind === "maintenance" || kind === "other"
          ? {
              maintenance: [
                {
                  ...(closed ? { ended: end } : undefined),
                  graceMinutes: 5,
                  instance: kind === "other" ? "unrelated" : "mailbox",
                  owner: "desk",
                  reason: "planned stop",
                  start,
                  until: end,
                },
              ],
            }
          : undefined),
        ...(kind === "receipt"
          ? {
              windows: [
                {
                  approval: "fixture",
                  celldAfter: null,
                  celldBefore: { entered: "before", pid: 1 },
                  end: end / 1000,
                  kind: "window",
                  reason: "planned stop",
                  result: "success",
                  start: start / 1000,
                },
              ],
            }
          : undefined),
      };

      const deadline = kind === "backup" && !closed ? start + 25 * 60_000 : end;
      const cutoff = start + 1000;
      const at = DateTime.makeUnsafe;

      const beat = ReaderHeartbeat.make({
        acquisitionSince: at(cutoff - 310_000),
        generation: 1,
        lastConsumeOk: at(cutoff),
        lastError: null,
        leaseHeldSince: null,
        leaseTtlMs: 300_000,
        leaseUntil: acquiring ? null : at(cutoff),
        name: "reader",
        owner: "desk",
        pid: 1,
        session: "fixture",
        startedAt: at(start - 600_000),
        state: acquiring ? "Acquiring" : "Retrying",
        updatedAt: at(cutoff),
      });

      const reading = (now: number, since = cutoff) => {
        const facts: typeof AlarmFacts.Type = {
          ...window,
          cacheBreaches: null,
          deploy: null,
          deployKnown: true,
          digest: "ok",
          doctor: true,
          entered: null,
          health: 200,
          measurementFailed: false,
          quarantinedHour: 0,
          readers: {
            complete: true,
            seen: [
              {
                host: "host.invalid",
                idleSeconds: Math.floor((now - since + READER_STUCK_MS) / 1000),
                lastError: null,
                name: "reader",
                owner: "desk",
                state: beat.state,
                verdict: "stuck",
              },
            ],
          },
          receipts: [],
          receiptsKnown: true,
          slots: null,
        };

        return observeAlarms(emptySources, facts, now).readings[
          "readers.stuck"
        ];
      };

      for (const now of [end, deadline + READER_RECOVERY_GRACE_MS]) {
        expect(crashedReader(beat, now, window) === undefined).toBe(
          kind !== "other"
        );
        expect(reading(now).status).toBe(kind === "other" ? "firing" : "ok");
        expect(reading(now, start - 1000).status).toBe("firing");
      }

      const lateCutoff = deadline + READER_RECOVERY_GRACE_MS - 1000;

      const late = ReaderHeartbeat.make({
        ...beat,
        acquisitionSince: at(lateCutoff - 310_000),
        leaseUntil: acquiring ? null : at(lateCutoff),
      });

      expect(crashedReader(late, lateCutoff, window) === undefined).toBe(
        kind !== "other"
      );
      expect(reading(lateCutoff, lateCutoff).status).toBe(
        kind === "other" ? "firing" : "ok"
      );

      const after = deadline + READER_RECOVERY_GRACE_MS + 1000;
      expect(crashedReader(late, after, window)?.state).toBe("crashed");
      expect(crashedReader(beat, after, window)?.state).toBe("crashed");
      expect(reading(after).status).toBe("firing");

      const earlier = ReaderHeartbeat.make({
        ...beat,
        acquisitionSince: at(start - 311_000),
        leaseUntil: acquiring ? null : at(start - 1000),
      });

      expect(crashedReader(earlier, end, window)?.state).toBe("crashed");
    })
);
