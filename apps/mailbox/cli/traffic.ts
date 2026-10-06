import * as Traffic from "@rat-king/lexicon/mailbox.listTraffic";
import { Transport } from "@rat-king/lexicon/transport";
import { Console, Effect, Schema, Schedule } from "effect";

import { CliError } from "./identity.ts";

export const traffic = Effect.fn("MailboxCli.traffic")(
  function* traffic(input: {
    readonly cursor: string;
    readonly follow: boolean;
  }) {
    const transport = yield* Transport;
    let { cursor } = input;

    const pass = Effect.gen(function* page() {
      let more = true;

      while (more) {
        const params = yield* Schema.encodeEffect(Traffic.Params)({
          cursor,
          limit: 100,
        });

        const response = yield* transport.request({
          input: undefined,
          method: "GET",
          nsid: Traffic.Method.nsid,
          params,
        });

        if (response.status !== 200 || response.kind !== "json") {
          return yield* new CliError({
            reason: `Traffic read refused (${response.status})`,
          });
        }

        const output = yield* Schema.decodeUnknownEffect(Traffic.Output)(
          response.body
        );

        for (const event of output.events) {
          yield* Console.log(
            JSON.stringify(yield* Schema.encodeEffect(Traffic.Entry)(event))
          );
        }

        ({ cursor } = output);
        more = output.events.length === 100;
      }

      return yield* Effect.void;
    });

    if (input.follow) {
      return yield* pass.pipe(Effect.repeat(Schedule.spaced("1 second")));
    }

    return yield* pass;
  }
);
