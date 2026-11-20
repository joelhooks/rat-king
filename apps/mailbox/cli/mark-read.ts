import * as Mark from "@rat-king/lexicon/mailbox.markRead";
import { Effect, Schema } from "effect";

import { CliError } from "./identity.ts";
import { operatorCall } from "./retire.ts";
import type { Authority } from "./retire.ts";

export const markInboxRead = Effect.fn("MailboxCli.markInboxRead")(
  function* markInboxRead(
    authority: Authority,
    recipientDid: string,
    upToSeq: number
  ) {
    const input = yield* Schema.decodeUnknownEffect(Mark.Input)({
      recipientDid,
      upToSeq,
    }).pipe(
      Effect.flatMap(Schema.encodeEffect(Mark.Input)),
      Effect.mapError(
        () =>
          new CliError({
            reason:
              "A valid recipient DID and admission sequence cutoff are required",
          })
      )
    );

    return yield* operatorCall(
      authority,
      { input, method: "POST", nsid: Mark.Method.nsid, params: undefined },
      Mark.Output
    );
  }
);
