import {
  MAILBOX_INSTANCE,
  closedReceiptWindow,
  coversOf,
  receiptMillis,
} from "./alarm-maintenance.ts";
import type { MaintenanceFacts } from "./alarm-maintenance.ts";
import type { AlarmFacts, WindowReceipt } from "./alarm-sources.ts";

export const READER_RECOVERY_GRACE_MS = 180_000;

export interface ReaderWindowFacts extends MaintenanceFacts {
  readonly windows?: readonly (typeof WindowReceipt.Type)[] | undefined;
}

export interface ReaderWindowObservation {
  readonly facts: ReaderWindowFacts;
  readonly observedAt: number;
}

export const updateReaderWindows = (
  previous: ReaderWindowObservation | null,
  facts: ReaderWindowFacts & Pick<typeof AlarmFacts.Type, "failed">,
  now: number
): ReaderWindowObservation | null =>
  (facts.failed ?? []).some((source) =>
    ["health", "maintenance", "windows"].includes(source)
  )
    ? previous
    : { facts, observedAt: now };

export const readerSweepWindows = (
  observation: ReaderWindowObservation | null,
  started: number,
  now: number
) => {
  if (now - (observation?.observedAt ?? started) >= READER_RECOVERY_GRACE_MS) {
    return { facts: {}, status: "stale" as const };
  }

  return observation === null
    ? { facts: null, status: "waiting" as const }
    : { facts: observation.facts, status: "fresh" as const };
};

export const readerRecovering = (
  since: number,
  facts: ReaderWindowFacts,
  now: number
) => {
  const windows = [
    ...coversOf(facts, MAILBOX_INSTANCE).map((cover) => ({
      end: cover.end - cover.grace * 60_000,
      start: cover.start,
    })),
    ...(facts.windows ?? [])
      .filter((window) => closedReceiptWindow(window.start, window.end, now))
      .map((window) => ({
        end: receiptMillis(window.end),
        start: receiptMillis(window.start),
      })),
  ];

  return windows.some(
    (window) =>
      since >= window.start &&
      since <= window.end + READER_RECOVERY_GRACE_MS &&
      now >= since &&
      now <= window.end + READER_RECOVERY_GRACE_MS
  );
};
