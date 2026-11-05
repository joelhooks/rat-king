import * as Retired from "@rat-king/lexicon/identity.listRetired";
import type { Transport } from "@rat-king/lexicon/transport";
import { Effect, Schema } from "effect";

import * as Deadline from "./deadline.ts";
import { MailboxClientError, clientError } from "./error.ts";

export const readRetirements = Effect.fn("Mailbox.readRetirements")(
  function* readRetirements(transport: Transport["Service"]) {
    let cursor: string | undefined;
    const names: string[] = [];

    for (let page = 0; page < 100; page += 1) {
      const response = yield* transport.request({
        input: undefined,
        method: "GET",
        nsid: Retired.Method.nsid,
        params: {
          ...(cursor === undefined ? undefined : { cursor }),
          limit: 100,
        },
      });

      if (response.status !== 200 || response.kind !== "json") {
        return yield* new MailboxClientError({
          reason: "Retirement observations unavailable",
        });
      }

      const output = yield* Schema.decodeUnknownEffect(Retired.Output)(
        response.body
      );

      names.push(...output.retired.map((item) => item.name));
      ({ cursor } = output);

      if (cursor === undefined) {
        return names;
      }
    }

    return yield* new MailboxClientError({
      reason: "Retirement scan exceeded 100 pages",
    });
  },
  (effect) =>
    effect.pipe(Deadline.timeout("10 seconds"), Effect.mapError(clientError))
);
