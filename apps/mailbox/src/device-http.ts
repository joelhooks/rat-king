import * as Pending from "@rat-king/lexicon/device.pendingPush";
import * as Register from "@rat-king/lexicon/device.register";
import { Effect, Schema } from "effect";

import type { Bindings } from "./bindings.ts";
import { pendingPush, registerDevice } from "./device.ts";
import { didAllowlist } from "./documents.ts";
import { failure } from "./failure.ts";
import type { Sql } from "./sqlite.ts";
import { trafficDid } from "./traffic-store.ts";

interface DeviceReply {
  readonly body: string;
  readonly status: number;
}

export const deviceMethods = [Pending.Method, Register.Method];

const parseRegistration = Effect.fn("Device.parseRegistration")(
  function* parseRegistration(request: Request) {
    if (
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    ) {
      return yield* failure("InvalidRequest");
    }

    const input = yield* Effect.tryPromise({
      catch: () => failure("InvalidRequest"),
      try: request.json.bind(request),
    });

    return yield* Schema.decodeUnknownEffect(Register.Input)(input).pipe(
      Effect.mapError(() => failure("InvalidRequest"))
    );
  }
);

export const deviceRequest = Effect.fn("Device.request")(
  function* deviceRequest(
    request: Request,
    env: Bindings,
    nsid: string,
    issuer: string
  ) {
    const method = deviceMethods.find((item) => item.nsid === nsid);

    if (method === undefined || request.method !== method.method) {
      return yield* failure("InvalidRequest");
    }

    const [recipient, input] = yield* method.nsid === Register.Method.nsid
      ? parseRegistration(request).pipe(
          Effect.map((value) => [value.did, value] as const)
        )
      : Pending.decodeParams([
          ...new URL(request.url).searchParams.entries(),
        ]).pipe(
          Effect.map((value) => [value.recipientDid, value] as const),
          Effect.mapError(() => failure("InvalidRequest"))
        );

    if (
      recipient === trafficDid ||
      (method.nsid === Register.Method.nsid
        ? recipient !== issuer
        : !didAllowlist(env.OPERATOR_DIDS).includes(issuer))
    ) {
      return yield* failure("Forbidden", 403);
    }

    const response = yield* Effect.tryPromise({
      catch: () => failure("MailboxUnavailable", 503),
      try: (): PromiseLike<DeviceReply> =>
        env.MAILBOX.getByName(recipient).device(
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

export const runDevice = Effect.fn("Device.run")(
  function* runDevice(
    sql: Sql,
    did: string,
    operators: readonly string[],
    nsid: string,
    input: string,
    issuer: string
  ) {
    if (nsid === Register.Method.nsid) {
      return yield* registerDevice(sql, did, issuer, input).pipe(
        Effect.flatMap(
          Schema.encodeEffect(Schema.fromJsonString(Register.Output))
        )
      );
    }

    const params = yield* Schema.decodeEffect(
      Schema.fromJsonString(Pending.Params)
    )(input).pipe(Effect.mapError(() => failure("InvalidRequest")));

    if (nsid !== Pending.Method.nsid || did !== params.recipientDid) {
      return yield* failure("Forbidden", 403);
    }

    return yield* pendingPush(sql, issuer, operators).pipe(
      Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Pending.Output)))
    );
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(failure("MailboxUnavailable", 503))
      )
    )
);
