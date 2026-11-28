import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

import {
  boundedWindow,
  closedWindow,
  closedReceiptWindow,
  coveringWindow,
  endWindow,
  MAX_WINDOW_MS,
  MaintenanceWindow,
  overranWindow,
  rememberedWindows,
  startWindow,
  WINDOW_MEMORY_MS,
  windowOpen,
} from "../../../stacks/nest/alarm-maintenance.ts";
import {
  readerRecovering,
  readerSweepWindows,
  updateReaderWindows,
  READER_RECOVERY_GRACE_MS,
} from "../../../stacks/nest/alarm-reader-windows.ts";
import { WindowReceipt } from "../../../stacks/nest/alarm-sources.ts";
import { decodeWindowReceipts } from "../../../stacks/nest/alarm-windows.ts";
import { epoch, integer, minute, positive } from "./nest-rule-generators.ts";

const windowSeed = Schema.Struct({
  instance: Schema.Literal("example"),
  owner: MaintenanceWindow.fields.owner,
  reason: MaintenanceWindow.fields.reason,
});

const receipt = WindowReceipt.mapFields((fields) => ({
  ...fields,
  start: integer(1_700_000_000, 1_900_000_000),
}));

it.prop(
  "bounds accept exactly twelve hours but reject one extra millisecond",
  [epoch],
  ([start]) => {
    expect(boundedWindow(start, start + MAX_WINDOW_MS)).toBe(true);
    expect(boundedWindow(start, start + MAX_WINDOW_MS + 1)).toBe(false);
  }
);

it.prop(
  "a reversed window never becomes closed, even well after both ends",
  [epoch, positive],
  ([at, delta]) => {
    expect(closedWindow(at, at - delta, at + delta)).toBe(false);
  }
);

it.prop(
  "a valid window closes at its exact end, not a tick earlier",
  [epoch, positive],
  ([start, span]) => {
    expect(closedWindow(start, start + span, start + span - 1)).toBe(false);
    expect(closedWindow(start, start + span, start + span)).toBe(true);
  }
);

it.prop(
  "receipt closure waits for the actual end even when it rounds to the current millisecond",
  [epoch],
  ([at]) => {
    expect(
      closedReceiptWindow((at - 1000) / 1000, (at + 0.25) / 1000, at)
    ).toBe(false);
  }
);

it.prop(
  "maintenance coverage uses inclusive start and end after grace",
  [windowSeed, epoch, positive, integer(0, 30)],
  ([seed, start, span, graceMinutes]) => {
    const until = start + span;
    const end = until + graceMinutes * minute;
    const facts = { maintenance: [{ ...seed, graceMinutes, start, until }] };
    expect(coveringWindow(facts, seed.instance, start - 1)).toBeUndefined();
    expect(coveringWindow(facts, seed.instance, start)?.start).toBe(start);
    expect(coveringWindow(facts, seed.instance, end)?.end).toBe(end);
    expect(coveringWindow(facts, seed.instance, end + 1)).toBeUndefined();
  }
);

it.prop(
  "remembering a window expires it exactly one day after its effective end",
  [windowSeed, epoch, positive, integer(0, 30)],
  ([seed, ended, span, graceMinutes]) => {
    const windows = [
      {
        ...seed,
        ended,
        graceMinutes,
        start: ended - span,
        until: ended + span,
      },
    ];

    const expiry = ended + graceMinutes * minute + WINDOW_MEMORY_MS;
    expect(rememberedWindows(windows, expiry - 1)).toEqual(windows);
    expect(rememberedWindows(windows, expiry)).toEqual([]);
  }
);

it.prop(
  "once explicitly ended a window cannot be ended again during its grace",
  [windowSeed, epoch, integer(1, 30)],
  ([seed, now, graceMinutes]) => {
    const window = {
      ...seed,
      graceMinutes,
      start: now - minute,
      until: now + minute,
    };

    const ended = endWindow([window], window.instance, now);
    expect(ended).toEqual([{ ...window, ended: now }]);
    expect(endWindow(ended ?? [], window.instance, now + 1)).toBeUndefined();
  }
);

it.prop(
  "a replacement closes only open windows for its own instance",
  [windowSeed, epoch, positive],
  ([seed, now, span]) => {
    const active = {
      ...seed,
      graceMinutes: 0,
      start: now - span,
      until: now + span,
    };

    const other = { ...active, instance: "other" };
    const ended = { ...active, ended: now - 1 };
    const replacement = { ...active, start: now };
    const all = startWindow([active, other, ended], replacement, now);
    expect(all).toEqual([{ ...active, ended: now }, other, ended, replacement]);
    expect(
      all.filter(
        (item) => item.instance === active.instance && windowOpen(item, now)
      )
    ).toEqual([replacement]);
  }
);

it.prop(
  "overrun picks the latest effective end and a recovery at that instant clears it",
  [windowSeed, epoch, positive, positive],
  ([seed, start, span, gap]) => {
    const older = { ...seed, graceMinutes: 0, start, until: start + span };
    const latest = { ...older, start: start + 1, until: older.until + gap };
    const facts = { maintenance: [older, latest] };
    expect(
      overranWindow(facts, seed.instance, undefined, latest.until + 1)?.start
    ).toBe(latest.start);
    expect(
      overranWindow(facts, seed.instance, latest.until, latest.until + 1)
    ).toBeUndefined();
  }
);

it.prop(
  "overrun does not resurrect a window once its evidence ages out",
  [windowSeed, epoch, positive],
  ([seed, until, span]) => {
    const facts = {
      maintenance: [{ ...seed, graceMinutes: 0, start: until - span, until }],
    };

    const expires = until + WINDOW_MEMORY_MS;
    expect(
      overranWindow(facts, seed.instance, undefined, expires - 1)
    ).toBeDefined();
    expect(
      overranWindow(facts, seed.instance, undefined, expires)
    ).toBeUndefined();
  }
);

it.prop(
  "receipt decoding preserves closed receipts in order despite malformed lines and future receipts",
  [receipt, integer(1, 600), integer(1, 600)],
  ([base, span, gap]) => {
    const first = { ...base, end: base.start + span };
    const second = { ...first, reason: `${first.reason}-next` };
    const future = { ...first, end: first.end + gap };

    const text = [
      JSON.stringify(first),
      "{",
      JSON.stringify(future),
      "",
      JSON.stringify(second),
    ].join("\n");

    expect(decodeWindowReceipts(text, first.end * 1000)).toEqual([
      first,
      second,
    ]);
  }
);

it.prop(
  "duration-invalid receipts are ignored even after their stated end",
  [receipt, positive],
  ([base, excess]) => {
    const end = base.start + MAX_WINDOW_MS / 1000 + excess;
    expect(
      decodeWindowReceipts(JSON.stringify({ ...base, end }), end * 1000)
    ).toEqual([]);
  }
);

it.prop(
  "an unrelated probe failure does not stop new observations refreshing reader windows",
  [epoch, positive, Schema.Literals(["receipts", "doctor", "quarantine"])],
  ([started, lag, failed]) => {
    const first = updateReaderWindows(null, {}, started);
    const observedAt = started + lag;
    const facts = { failed: [failed], windows: [] };
    expect(
      readerSweepWindows(
        updateReaderWindows(first, facts, observedAt),
        started,
        observedAt + READER_RECOVERY_GRACE_MS - 1
      )
    ).toEqual({ facts, status: "fresh" });
  }
);

it.prop(
  "a reader observation has no cover at the first stale millisecond",
  [epoch, positive],
  ([started, lag]) => {
    const observedAt = started + lag;
    const observation = updateReaderWindows(null, {}, observedAt);
    expect(
      readerSweepWindows(
        observation,
        started,
        observedAt + READER_RECOVERY_GRACE_MS
      )
    ).toEqual({ facts: {}, status: "stale" });
  }
);

it.prop(
  "a closed receipt protects readers only within its own recovery grace",
  [receipt, integer(1, 600)],
  ([base, seconds]) => {
    const end = base.start + seconds;
    const deadline = end * 1000 + READER_RECOVERY_GRACE_MS;
    const since = base.start * 1000;
    const facts = { windows: [{ ...base, end }] };
    expect(readerRecovering(since, facts, deadline)).toBe(true);
    expect(readerRecovering(since, facts, deadline + 1)).toBe(false);
    expect(readerRecovering(since - 1, facts, deadline)).toBe(false);
  }
);

it.prop(
  "a not-yet-closed receipt cannot explain a stopped reader retroactively",
  [receipt, integer(1, 600)],
  ([base, seconds]) => {
    const since = base.start * 1000;
    const end = base.start + seconds;
    expect(
      readerRecovering(since, { windows: [{ ...base, end }] }, end * 1000 - 1)
    ).toBe(false);
  }
);
