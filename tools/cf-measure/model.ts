import { Schema } from "effect";

import { MailboxClientError } from "../../packages/mailbox-client/src/error.ts";

export class MeasureError extends Schema.TaggedError<MeasureError>()(
  "MeasureError",
  { reason: Schema.String }
) {}

export const testDid = (did: string) =>
  /^did:web:cfpreview-[a-z0-9-]+\.test\.invalid$/u.test(did);

export const percentile = (samples: readonly number[], quantile: number) => {
  const sorted = samples.toSorted((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
};

export const distribution = (samples: readonly number[]) => ({
  count: samples.length,
  p50: percentile(samples, 0.5),
  p95: percentile(samples, 0.95),
  p99: percentile(samples, 0.99),
});

export type Event = Readonly<Record<string, Schema.Json>>;

export const classify = (cause: unknown) => {
  if (Schema.is(MailboxClientError)(cause)) {
    return (
      cause.error ??
      (cause.status === undefined ? "Transport" : `HTTP${cause.status}`)
    );
  }

  if (Schema.is(MeasureError)(cause)) {
    return "MeasureError";
  }

  return "Unexpected";
};

export interface Timing {
  readonly id: string;
  readonly started: number;
  readonly accepted?: number;
  readonly received?: number;
  readonly ackStarted?: number;
  readonly acked?: number;
}

export const latencies = (timing: Timing) => ({
  ack:
    timing.acked === undefined || timing.ackStarted === undefined
      ? undefined
      : timing.acked - timing.ackStarted,
  delivery:
    timing.received === undefined || timing.accepted === undefined
      ? undefined
      : timing.received - timing.accepted,
  send:
    timing.accepted === undefined
      ? undefined
      : timing.accepted - timing.started,
});

export const summarize = (
  timings: readonly Timing[],
  errors: Readonly<Record<string, number>>
) => {
  const samples = timings.map(latencies);

  return {
    ackMs: distribution(
      samples.flatMap((sample) =>
        sample.ack === undefined ? [] : [sample.ack]
      )
    ),
    attempted: timings.length,
    deliveryMs: distribution(
      samples.flatMap((sample) =>
        sample.delivery === undefined ? [] : [sample.delivery]
      )
    ),
    errors,
    incomplete: timings.filter(
      (timing) => timing.acked === undefined || timing.accepted === undefined
    ).length,
    receiptBeforeAccept: samples.filter(
      (sample) => sample.delivery !== undefined && sample.delivery < 0
    ).length,
    sendMs: distribution(
      samples.flatMap((sample) =>
        sample.send === undefined ? [] : [sample.send]
      )
    ),
  };
};
