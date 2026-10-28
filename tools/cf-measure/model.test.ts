import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";

import { MailboxClientError } from "../../packages/mailbox-client/src/error.ts";
import {
  classify,
  distribution,
  latencies,
  percentile,
  summarize,
} from "./model.ts";

const Millis = Schema.Int.check(
  Schema.isBetween({ maximum: 1_000_000, minimum: 0 })
);

it.prop(
  "latencies preserve measured intervals and receipt-before-accept races",
  {
    ack: Arbitrary.schema(Millis),
    delivery: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: -1000 }))
    ),
    send: Arbitrary.schema(Millis),
    start: Arbitrary.schema(Millis),
  },
  ({ ack, delivery, send, start }) => {
    const timing = {
      accepted: start + send,
      ackStarted: start + send + delivery,
      acked: start + send + delivery + ack,
      id: "test",
      received: start + send + delivery,
      started: start,
    };

    expect(latencies(timing)).toEqual({ ack, delivery, send });
    expect(summarize([timing], {}).receiptBeforeAccept).toBe(
      delivery < 0 ? 1 : 0
    );
  }
);

it.prop(
  "nearest-rank percentiles use the ordered empirical sample, without mutating input",
  {
    values: Arbitrary.schema(
      Schema.Array(Millis).check(Schema.isMinLength(1), Schema.isMaxLength(100))
    ),
  },
  ({ values }) => {
    const original = [...values];
    const sorted = values.toSorted((a, b) => a - b);

    for (const quantile of [0.5, 0.95, 0.99]) {
      expect(percentile(values, quantile)).toBe(
        sorted[Math.ceil(sorted.length * quantile) - 1]
      );
    }

    expect(values).toEqual(original);
    expect(distribution([])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      p99: null,
    });
  }
);

it.prop(
  "error tags preserve mailbox classifications but never include response text",
  {
    status: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 400 }))
    ),
    tag: Arbitrary.schema(Schema.NonEmptyString),
  },
  ({ status, tag }) => {
    expect(
      classify(
        new MailboxClientError({
          error: tag,
          reason: "private response",
          status,
        })
      )
    ).toBe(tag);
    expect(
      classify(new MailboxClientError({ reason: "private response", status }))
    ).toBe(`HTTP${status}`);
    expect(
      classify(new MailboxClientError({ reason: "private response" }))
    ).toBe("Transport");
    expect(classify(new Error("private response"))).toBe("Unexpected");
  }
);

it.effect(
  "missing observations remain incomplete, not zero-latency successes",
  () =>
    Effect.sync(() => {
      const result = summarize([{ id: "test", started: 1 }], { Timeout: 1 });

      expect(result).toMatchObject({
        attempted: 1,
        errors: { Timeout: 1 },
        incomplete: 1,
      });
      expect(result.sendMs.count).toBe(0);
      expect(result.deliveryMs.p99).toBeNull();
    })
);
