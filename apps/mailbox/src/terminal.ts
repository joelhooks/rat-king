import type * as Defs from "@rat-king/lexicon/defs";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Clock, Context, Effect, Layer } from "effect";

import { failure } from "./failure.ts";
import { transitionMessage } from "./mailbox.ts";
import { MailboxStore } from "./store.ts";

export class TerminalDelivery extends Context.Service<
  TerminalDelivery,
  {
    readonly settle: (
      sender: string,
      tid: string,
      command: "expire" | "fail",
      detail?: string
    ) => Effect.Effect<Defs.ReceiptValue, XrpcFailure>;
  }
>()("mailbox/TerminalDelivery") {}

export const terminalLayer = Layer.effect(
  TerminalDelivery,
  Effect.gen(function* terminalLayer() {
    const store = yield* MailboxStore;

    return TerminalDelivery.of({
      settle: Effect.fn("Delivery.settle")(
        function* settle(sender, tid, command, detail) {
          const now = yield* Clock.currentTimeMillis;

          return yield* store.transaction((tx) => {
            const message = tx.get(sender, tid);

            if (!message) {
              throw failure("MessageNotFound", 404);
            }

            if (
              command === "expire" &&
              (message.envelope.aad.expiresAt === undefined ||
                Date.parse(message.envelope.aad.expiresAt) > now)
            ) {
              throw failure(
                "InvalidTransition",
                409,
                "Sender expiry has not been reached"
              );
            }

            const terminal = command === "expire" ? "expired" : "failed";

            if (message.current.state === terminal) {
              return message.current;
            }

            return transitionMessage(tx, message, command, detail);
          });
        }
      ),
    });
  })
);
