import * as Pending from "@rat-king/lexicon/device.pendingPush";
import * as Register from "@rat-king/lexicon/device.register";
import type { Transport } from "@rat-king/lexicon/transport";
import { Effect, Schema } from "effect";

import { MailboxClientError, clientError } from "./error.ts";

export const registerDevice = Effect.fn("Mailbox.registerDevice")(
  function* registerDevice(
    transport: Transport["Service"],
    input: Register.InputValue
  ) {
    const response = yield* transport.request({
      input: yield* Schema.encodeEffect(Register.Input)(input),
      method: "POST",
      nsid: Register.Method.nsid,
      params: undefined,
    });

    if (response.status !== 200 || response.kind !== "json") {
      return yield* new MailboxClientError({
        reason: "Device registration refused",
        status: response.status,
      });
    }

    return yield* Schema.decodeUnknownEffect(Register.Output)(response.body);
  },
  Effect.mapError(clientError)
);

export const readPendingPush = Effect.fn("Mailbox.readPendingPush")(
  function* readPendingPush(
    transport: Transport["Service"],
    recipientDid: string
  ) {
    const params = yield* Schema.decodeUnknownEffect(
      Schema.toType(Pending.Params)
    )({ recipientDid });

    const response = yield* transport.request({
      input: undefined,
      method: "GET",
      nsid: Pending.Method.nsid,
      params: yield* Schema.encodeEffect(Pending.Params)(params),
    });

    if (response.status !== 200 || response.kind !== "json") {
      return yield* new MailboxClientError({
        reason: "Device projection unavailable",
        status: response.status,
      });
    }

    return yield* Schema.decodeUnknownEffect(Pending.Output)(response.body);
  },
  (effect) =>
    effect.pipe(
      Effect.mapError(
        () =>
          new MailboxClientError({ reason: "Device projection unavailable" })
      )
    )
);
