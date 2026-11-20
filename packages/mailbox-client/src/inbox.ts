import * as Page from "@rat-king/lexicon/mailbox.listPage";
import * as Mark from "@rat-king/lexicon/mailbox.markRead";
import type { Request, Transport } from "@rat-king/lexicon/transport";
import { Effect, Option, Schema } from "effect";

import { clientError, MailboxClientError } from "./error.ts";

const ErrorBody = Schema.Struct({ error: Schema.String });

const phoneCall = Effect.fn("Mailbox.phoneCall")(function* phoneCall<
  S extends Schema.Top,
>(transport: Transport["Service"], request: Request, schema: S) {
  const response = yield* transport.request(request);

  if (response.kind !== "json" || response.status !== 200) {
    const error = Option.getOrUndefined(
      Schema.decodeUnknownOption(ErrorBody)(response.body)
    )?.error;

    return yield* new MailboxClientError({
      ...(error === undefined ? undefined : { error }),
      reason: "Mailbox inbox request refused",
      status: response.status,
    });
  }

  return yield* Schema.decodeUnknownEffect(schema)(response.body);
}, Effect.mapError(clientError));

export const listPage = Effect.fn("Mailbox.listPage")(function* listPage(
  transport: Transport["Service"],
  params: Page.ParamsValue
) {
  return yield* phoneCall(
    transport,
    {
      input: undefined,
      method: "GET",
      nsid: Page.Method.nsid,
      params: yield* Schema.encodeEffect(Page.Params)(params),
    },
    Page.Output
  );
}, Effect.mapError(clientError));

export const markRead = Effect.fn("Mailbox.markRead")(function* markRead(
  transport: Transport["Service"],
  input: Mark.InputValue
) {
  return yield* phoneCall(
    transport,
    {
      input: yield* Schema.encodeEffect(Mark.Input)(input),
      method: "POST",
      nsid: Mark.Method.nsid,
      params: undefined,
    },
    Mark.Output
  );
}, Effect.mapError(clientError));
