import * as Health from "@rat-king/lexicon/mailbox.nameHealth";
import type { Transport } from "@rat-king/lexicon/transport";
import { DateTime, Effect, Schema } from "effect";

import * as Deadline from "./deadline.ts";
import { clientError, MailboxClientError } from "./error.ts";

export const WAKE_UNACKED_MS = 180_000;

export const Wake = Schema.Struct({
  at: Schema.Finite,
  id: Schema.String,
  sender: Schema.String,
  seq: Health.Wake.schema.fields.seq,
});

export const MailboxHealth = Schema.Struct({
  complete: Schema.Boolean,
  lastAck: Schema.NullOr(Schema.Finite),
  lastTurnStartedAt: Schema.optionalKey(Schema.Finite),
  lease: Schema.NullOr(
    Schema.Struct({
      expiresAt: Schema.Finite,
      generation: Schema.Int,
      holder: Schema.String,
      pane: Schema.NullOr(Schema.String),
    })
  ),
  oldestUndeliveredAt: Schema.optionalKey(Schema.Finite),
  oldestWake: Schema.NullOr(Wake),
  oldestWakeSinceAck: Schema.optionalKey(Schema.NullOr(Wake)),
  quietUnacked: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  retired: Schema.optionalKey(Schema.Boolean),
  undelivered: Health.Output.schema.fields.undelivered,
});

export type MailboxHealthValue = typeof MailboxHealth.Type;

export interface HealthFacts extends MailboxHealthValue {
  readonly unavailable?: string;
  readonly reader: "running" | "stuck" | "unknown";
}

export const healthVerdict = (facts: HealthFacts, now: number) => {
  if (facts.lease === null) {
    return `unknown (${facts.unavailable ?? "lease unavailable"})`;
  }

  if (facts.lease.expiresAt <= now) {
    return "unknown (lease expired)";
  }

  if (facts.reader === "stuck") {
    return "reader stuck";
  }

  if (
    facts.oldestWake !== null &&
    now - facts.oldestWake.at > WAKE_UNACKED_MS
  ) {
    return "agent not taking turns";
  }

  if (!facts.complete) {
    return "unknown (mailbox snapshot incomplete or receipt missing wake/time)";
  }

  return facts.reader === "unknown" ? "unknown (reader unavailable)" : "ok";
};

const LeaseExpiryMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(Date.UTC(2000, 0, 1))
);

const decodeLeaseExpiry = (value: typeof Health.Lease.Type.expiresAt) =>
  Schema.decodeEffect(Schema.DateTimeUtcFromString)(value).pipe(
    Effect.map(DateTime.toEpochMillis),
    Effect.flatMap(Schema.decodeEffect(LeaseExpiryMillis))
  );

export const readMailboxHealth = Effect.fn("Mailbox.readHealth")(
  function* readMailboxHealth(
    transport: Transport["Service"],
    did: string,
    name: string
  ) {
    const params = yield* Schema.decodeUnknownEffect(
      Schema.toType(Health.Params)
    )({ name, recipientDid: did });

    const response = yield* transport.request({
      input: undefined,
      method: "GET",
      nsid: Health.Method.nsid,
      params: yield* Schema.encodeEffect(Health.Params)(params),
    });

    if (response.status !== 200 || response.kind !== "json") {
      return yield* new MailboxClientError({
        reason:
          "Health projection unavailable (operator or health reader credentials required)",
      });
    }

    const value = yield* Schema.decodeUnknownEffect(Health.Output)(
      response.body
    );

    const facts: typeof MailboxHealth.Encoded = {
      complete: value.complete,
      ...(value.retired === undefined ? undefined : { retired: value.retired }),
      lastAck: value.lastAck === undefined ? null : Date.parse(value.lastAck),
      ...(value.lastTurnStartedAt === undefined
        ? undefined
        : { lastTurnStartedAt: Date.parse(value.lastTurnStartedAt) }),
      lease:
        value.lease === undefined
          ? null
          : {
              expiresAt: yield* decodeLeaseExpiry(value.lease.expiresAt),
              generation: value.lease.generation,
              holder: value.lease.holder,
              pane: value.lease.pane ?? null,
            },
      ...(value.oldestUndeliveredAt === undefined
        ? undefined
        : { oldestUndeliveredAt: Date.parse(value.oldestUndeliveredAt) }),
      ...(value.undelivered === undefined
        ? undefined
        : { undelivered: value.undelivered }),
      oldestWake:
        value.oldestWake === undefined
          ? null
          : {
              at: Date.parse(value.oldestWake.recordedAt),
              id: value.oldestWake.id,
              sender: value.oldestWake.sender,
            },
      quietUnacked: value.quietUnacked,
    };

    if (value.wakesSinceAck === undefined) {
      return yield* Schema.decodeEffect(MailboxHealth)(facts);
    }

    const since = value.oldestWakeSinceAck;

    return yield* Schema.decodeEffect(MailboxHealth)({
      ...facts,
      oldestWakeSinceAck:
        since === undefined
          ? null
          : {
              at: Date.parse(since.recordedAt),
              id: since.id,
              sender: since.sender,
              ...(since.seq === undefined ? undefined : { seq: since.seq }),
            },
    });
  },
  (effect) =>
    effect.pipe(Deadline.timeout("10 seconds"), Effect.mapError(clientError))
);
