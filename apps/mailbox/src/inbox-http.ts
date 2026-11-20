import * as Page from "@rat-king/lexicon/mailbox.listPage";
import * as Mark from "@rat-king/lexicon/mailbox.markRead";
import { Effect, Schema } from "effect";

import type { Bindings } from "./bindings.ts";
import { didAllowlist } from "./documents.ts";
import { failure } from "./failure.ts";
import { listPage, markRead } from "./inbox-page.ts";
import type { MailboxStore } from "./store.ts";
import { trafficDid } from "./traffic-store.ts";

interface InboxReply {
  readonly body: string;
  readonly status: number;
}

export const inboxMethods = [Page.Method, Mark.Method];

const parseMark = Effect.fn("Mailbox.parseMarkRead")(function* parseMark(
  request: Request
) {
  if (
    request.headers.get("content-type")?.split(";")[0] !== "application/json"
  ) {
    return yield* failure("InvalidRequest");
  }

  return yield* Effect.tryPromise({
    catch: () => failure("InvalidRequest"),
    try: request.text.bind(request),
  }).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Mark.Input))),
    Effect.mapError(() => failure("InvalidRequest"))
  );
});

export const inboxRequest = Effect.fn("Mailbox.inboxRequest")(
  function* inboxRequest(
    request: Request,
    env: Bindings,
    nsid: string,
    issuer: string
  ) {
    const method = inboxMethods.find((candidate) => candidate.nsid === nsid);

    if (method === undefined || request.method !== method.method) {
      return yield* failure("InvalidRequest");
    }

    const authorized =
      method.nsid === Mark.Method.nsid
        ? didAllowlist(env.OPERATOR_DIDS).includes(issuer)
        : true;

    if (!authorized) {
      return yield* failure("Forbidden", 403);
    }

    const input = yield* method.nsid === Mark.Method.nsid
      ? parseMark(request)
      : Page.decodeParams([
          ...new URL(request.url).searchParams.entries(),
        ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

    const { recipientDid } = input;

    if (
      recipientDid === trafficDid ||
      (method.nsid === Page.Method.nsid && issuer !== recipientDid)
    ) {
      return yield* failure("Forbidden", 403);
    }

    const response = yield* Effect.tryPromise({
      catch: () => failure("MailboxUnavailable", 503),
      try: (): PromiseLike<InboxReply> =>
        env.MAILBOX.getByName(recipientDid).inbox(
          method.nsid,
          JSON.stringify(input),
          issuer
        ),
    });

    return new Response(response.body, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
      status: response.status,
    });
  }
);

export const runInbox = Effect.fn("Mailbox.runInbox")(
  function* runInbox(
    nsid: string,
    input: string,
    issuer: string,
    operators: readonly string[]
  ) {
    if (nsid === Mark.Method.nsid) {
      const params = yield* Schema.decodeEffect(
        Schema.fromJsonString(Mark.Input)
      )(input).pipe(Effect.mapError(() => failure("InvalidRequest")));

      return yield* markRead(params, issuer, operators).pipe(
        Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Mark.Output)))
      );
    }

    if (nsid !== Page.Method.nsid) {
      return yield* failure("InvalidRequest");
    }

    const params = yield* Schema.decodeEffect(
      Schema.fromJsonString(Page.Params)
    )(input).pipe(Effect.mapError(() => failure("InvalidRequest")));

    return yield* listPage(params, issuer).pipe(
      Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Page.Output)))
    );
  },
  (effect): Effect.Effect<string, ReturnType<typeof failure>, MailboxStore> =>
    effect.pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(failure("MailboxUnavailable", 503))
      )
    )
);
