import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import {
  MAX_WINDOW_MS,
  readMaintenance,
} from "../../../stacks/nest/alarm-maintenance.ts";
import {
  READER_RECOVERY_GRACE_MS,
  readerRecovering,
} from "../../../stacks/nest/alarm-reader-windows.ts";
import { WindowReceipt } from "../../../stacks/nest/alarm-sources.ts";
import { decodeWindowReceipts } from "../../../stacks/nest/alarm-windows.ts";

it.effect.prop(
  "receipt seconds preserve exact millisecond close and grace boundaries without accepting future ends",
  {
    epoch: Schema.Int.check(
      Schema.isBetween({ maximum: 2_000_000_000_000, minimum: 1_000_000 })
    ),
    span: Schema.Int.check(
      Schema.isBetween({ maximum: MAX_WINDOW_MS, minimum: 20_000 })
    ),
  },
  ({ epoch, span }) =>
    Effect.sync(() => {
      const end = epoch + span;

      const receipt = WindowReceipt.make({
        approval: "fixture",
        celldAfter: null,
        celldBefore: { entered: "before", pid: 1 },
        end: end / 1000,
        kind: "window",
        reason: "planned stop",
        result: "success",
        start: epoch / 1000,
      });

      const facts = { windows: [receipt] };
      const text = JSON.stringify(receipt);

      for (const now of [end, end + READER_RECOVERY_GRACE_MS]) {
        expect(decodeWindowReceipts(text, now)).toEqual([receipt]);
        expect(readerRecovering(epoch + 1, facts, now)).toBe(true);
      }

      expect(decodeWindowReceipts(text, end - 1)).toEqual([]);
      expect(
        decodeWindowReceipts(
          JSON.stringify({ ...receipt, end: receipt.end + 0.000001 }),
          end
        )
      ).toEqual([]);
      expect(readerRecovering(epoch - 1, facts, end)).toBe(false);
      expect(
        readerRecovering(epoch + 1, facts, end + READER_RECOVERY_GRACE_MS + 1)
      ).toBe(false);
    }),
  { arbitrary: { runs: 1000 } }
);

it.effect.prop(
  "window receipt and maintenance reads reject future, inverted and overlong ends instead of hiding failures indefinitely",
  {
    span: Schema.Int.check(
      Schema.isBetween({ maximum: MAX_WINDOW_MS - 1, minimum: 2000 })
    ),
  },
  ({ span }) =>
    Effect.gen(function* boundedReads() {
      const start = -span;

      const receipt = {
        approval: "fixture",
        celldAfter: null,
        celldBefore: { entered: "before", pid: 1 },
        end: -0.001,
        kind: "window",
        reason: "planned stop",
        result: "success",
        start: start / 1000,
      };

      expect(decodeWindowReceipts(JSON.stringify(receipt), 0)).toEqual([
        receipt,
      ]);

      for (const end of [
        0.001,
        receipt.start - 1,
        receipt.start + MAX_WINDOW_MS / 1000 + 1,
      ]) {
        expect(
          decodeWindowReceipts(JSON.stringify({ ...receipt, end }), 0)
        ).toEqual([]);
      }

      expect(
        decodeWindowReceipts(
          JSON.stringify(receipt).replace('"end":-0.001', '"end":1e999'),
          0
        )
      ).toEqual([]);

      const window = {
        ended: -1,
        graceMinutes: 5,
        instance: "mailbox",
        owner: "desk",
        reason: "planned stop",
        start,
        until: 0,
      };

      const read = (value: typeof window) =>
        readMaintenance("/fixture").pipe(
          Effect.provide(
            FileSystem.layerNoop({
              exists: () => Effect.succeed(true),
              readFileString: () =>
                Effect.succeed(
                  JSON.stringify({ version: 1, windows: [value] })
                ),
            })
          )
        );

      expect(yield* read(window)).toEqual([window]);

      for (const ended of [1, start - 1, start + MAX_WINDOW_MS + 1]) {
        expect(yield* read({ ...window, ended })).toEqual([]);
      }

      expect(
        yield* read({ ...window, until: start + MAX_WINDOW_MS + 1 })
      ).toEqual([]);
    })
);
