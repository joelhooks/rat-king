import { MAILBOX_INSTANCE, coversOf } from "./alarm-maintenance.ts";
import type { MaintenanceFacts } from "./alarm-maintenance.ts";
import type { WindowReceipt } from "./alarm-sources.ts";

export const READER_RECOVERY_GRACE_MS = 180_000;

export interface ReaderWindowFacts extends MaintenanceFacts {
  readonly windows?: readonly (typeof WindowReceipt.Type)[] | undefined;
}

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
    ...(facts.windows ?? []).map((window) => ({
      end: window.end * 1000,
      start: window.start * 1000,
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
