import * as Health from "@rat-king/lexicon/mailbox.nameHealth";
import type { Transport } from "@rat-king/lexicon/transport";
import { Effect, Schema } from "effect";

import * as Deadline from "./deadline.ts";
import { clientError, MailboxClientError } from "./error.ts";

export const WAKE_UNACKED_MS = 180_000;

export const Wake = Schema.Struct({
  at: Schema.Finite,
  id: Schema.String,
  sender: Schema.String,
});

export const MailboxHealth = Schema.Struct({
  complete: Schema.Boolean,
  lastAck: Schema.NullOr(Schema.Finite),
  lease: Schema.NullOr(
    Schema.Struct({
      expiresAt: Schema.Finite,
      generation: Schema.Int,
      holder: Schema.String,
      pane: Schema.NullOr(Schema.String),
    })
  ),
  oldestWake: Schema.NullOr(Wake),
  quietUnacked: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
        reason: "Health projection unavailable (operator credentials required)",
      });
    }

    const value = yield* Schema.decodeUnknownEffect(Health.Output)(
      response.body
    );

    return yield* Schema.decodeEffect(MailboxHealth)({
      complete: value.complete,
      lastAck: value.lastAck === undefined ? null : Date.parse(value.lastAck),
      lease:
        value.lease === undefined
          ? null
          : {
              expiresAt: Date.parse(value.lease.expiresAt),
              generation: value.lease.generation,
              holder: value.lease.holder,
              pane: value.lease.pane ?? null,
            },
      oldestWake:
        value.oldestWake === undefined
          ? null
          : {
              at: Date.parse(value.oldestWake.recordedAt),
              id: value.oldestWake.id,
              sender: value.oldestWake.sender,
            },
      quietUnacked: value.quietUnacked,
    });
  },
  (effect) =>
    effect.pipe(Deadline.timeout("10 seconds"), Effect.mapError(clientError))
);
