import * as Traffic from "@rat-king/lexicon/mailbox.listTraffic";
import type { Transport } from "@rat-king/lexicon/transport";
import { Turn } from "@rat-king/lexicon/turns";
import { Effect, Option, Schema } from "effect";

import * as Deadline from "./deadline.ts";
import { MailboxClientError, clientError } from "./error.ts";
import { PayloadJson } from "./payload.ts";

export const readTurnHealth = Effect.fn("Mailbox.readTurnHealth")(
  function* readTurnHealth(
    transport: Transport["Service"],
    did: string,
    name: string,
    session: string,
    startsOnly?: boolean
  ) {
    let cursor = "0";

    let last: {
      readonly at: string;
      readonly state: string;
      readonly turnId: string;
    } | null = null;

    for (let page = 0; page < 100; page += 1) {
      const response = yield* transport.request({
        input: undefined,
        method: "GET",
        nsid: Traffic.Method.nsid,
        params: { cursor, limit: 100 },
      });

      if (response.status !== 200 || response.kind !== "json") {
        return yield* new MailboxClientError({
          reason: "Turn record observations unavailable",
        });
      }

      const output = yield* Schema.decodeUnknownEffect(Traffic.Output)(
        response.body
      );

      for (const event of output.events) {
        if (event.senderDid !== did) {
          continue;
        }

        const text = event.body ?? "";
        const payload = Schema.decodeOption(PayloadJson)(text);

        const body = Option.match(payload, {
          onNone: () => text,
          onSome: (value) => value.body,
        });

        const record = Schema.decodeOption(Schema.fromJsonString(Turn))(body);

        if (
          Option.isSome(record) &&
          record.value.agent === name &&
          record.value.session === session &&
          (startsOnly !== true || record.value.state === "working") &&
          (last === null || record.value.at > last.at)
        ) {
          last = {
            at: record.value.at,
            state: record.value.state,
            turnId: record.value.turnId,
          };
        }
      }

      ({ cursor } = output);

      if (output.events.length < 100) {
        return last;
      }
    }

    return yield* new MailboxClientError({
      reason: "Turn record scan exceeded 100 pages",
    });
  },
  (effect) =>
    effect.pipe(Deadline.timeout("10 seconds"), Effect.mapError(clientError))
);
