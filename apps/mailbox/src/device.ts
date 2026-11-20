import { plaintextBody } from "@rat-king/envelope/signed";
import * as Defs from "@rat-king/lexicon/defs";
import type * as Pending from "@rat-king/lexicon/device.pendingPush";
import * as Register from "@rat-king/lexicon/device.register";
import { Clock, Effect, Option, Schema } from "effect";

import { PayloadJson } from "../../../packages/mailbox-client/src/payload.ts";
import { failure } from "./failure.ts";
import type { Sql } from "./sqlite.ts";
import { Lease, storageOperation } from "./store.ts";

const Row = Schema.Struct({ value: Schema.String });

const Token = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-fA-F]{2}){1,256}$/u)
);

const Device = Schema.Struct({
  environment: Register.Input.schema.fields.environment,
  token: Token,
});

const Candidate = Schema.fromJsonString(
  Schema.Struct({ admission: Defs.Receipt, envelope: Defs.EncryptedEnvelope })
);

const first = (sql: Sql, query: string) => {
  const [row] = sql.exec(query);

  return row === undefined
    ? undefined
    : Schema.decodeUnknownSync(Row)(row).value;
};

export const registerDevice = Effect.fn("Device.register")(
  function* registerDevice(
    sql: Sql,
    recipient: string,
    issuer: string,
    input: string
  ) {
    const value = yield* Schema.decodeEffect(
      Schema.fromJsonString(Register.Input)
    )(input).pipe(Effect.mapError(() => failure("InvalidRequest")));

    if (issuer !== recipient || value.did !== recipient) {
      return yield* failure("Forbidden", 403);
    }

    if (!Schema.is(Token)(value.token)) {
      return yield* failure("InvalidRequest");
    }

    yield* storageOperation(() => {
      sql.transaction(() => {
        if (
          first(sql, "SELECT value FROM metadata WHERE key='retirement'") !==
          undefined
        ) {
          throw failure("Forbidden", 403);
        }

        sql.exec(
          "INSERT INTO metadata (key,value) VALUES ('iosDevice',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          JSON.stringify({
            environment: value.environment,
            token: value.token.toLowerCase(),
          })
        );
      });
    });

    return { registered: true } as const;
  }
);

const summaryText = (text: string) => {
  const encoder = new TextEncoder();
  let bytes = 0;
  let length = 0;

  for (const unit of text) {
    bytes += encoder.encode(unit).length;

    if (bytes > 280) {
      break;
    }

    length += unit.length;
  }

  return text.slice(0, length);
};

const preview = Effect.fn("Device.preview")(function* preview(
  envelope: Defs.EncryptedEnvelopeValue
) {
  const decoded = yield* plaintextBody(envelope).pipe(
    Effect.flatMap(Schema.decodeEffect(PayloadJson)),
    Effect.option
  );

  if (Option.isNone(decoded)) {
    return { body: "New sealed message", title: "Rat King" };
  }

  if (decoded.value.quiet === true || decoded.value.kind === "data") {
    return null;
  }

  return {
    body: summaryText(decoded.value.summary ?? "New message"),
    title: decoded.value.from,
  };
});

const snapshot = (sql: Sql, now: number) =>
  sql.transaction(() => {
    const encoded = first(
      sql,
      "SELECT value FROM metadata WHERE key='iosDevice'"
    );

    const lease = first(sql, "SELECT value FROM lease WHERE singleton=1");

    const retired = first(
      sql,
      "SELECT value FROM metadata WHERE key='retirement'"
    );

    if (
      encoded === undefined ||
      retired !== undefined ||
      (lease !== undefined &&
        Schema.decodeSync(Schema.fromJsonString(Lease))(lease).expiresAt > now)
    ) {
      return null;
    }

    return {
      device: Schema.decodeSync(Schema.fromJsonString(Device))(encoded),
      messages: Array.from(
        sql.exec(
          "SELECT value FROM messages WHERE json_extract(value,'$.current.state') IN ('accepted','queued') AND coalesce(json_extract(value,'$.admission.woke'),1)=1 ORDER BY json_extract(value,'$.admission.seq') DESC LIMIT 32"
        ),
        (row) =>
          Schema.decodeSync(Candidate)(Schema.decodeUnknownSync(Row)(row).value)
      ),
    };
  });

export const pendingPush = Effect.fn("Device.pendingPush")(
  function* pendingPush(
    sql: Sql,
    issuer: string,
    operators: readonly string[]
  ) {
    if (!operators.includes(issuer)) {
      return yield* failure("Forbidden", 403);
    }

    const now = yield* Clock.currentTimeMillis;
    const data = yield* storageOperation(() => snapshot(sql, now));

    if (data === null) {
      return {};
    }

    for (const { admission, envelope } of data.messages) {
      const { expiresAt } = envelope.aad;

      if (expiresAt !== undefined && Date.parse(expiresAt) <= now) {
        continue;
      }

      const text = yield* preview(envelope);

      if (text !== null) {
        return {
          notice: {
            ...data.device,
            ...text,
            admissionSeq: admission.seq,
            messageId: envelope.aad.messageId,
          },
        } satisfies typeof Pending.Output.Type;
      }
    }

    return {};
  }
);
