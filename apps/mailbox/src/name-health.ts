/* oxlint-disable promise/prefer-await-to-callbacks -- Effect error mapping stays in the typed error channel. */
import { plaintextBody } from "@rat-king/envelope/signed";
import * as Defs from "@rat-king/lexicon/defs";
import * as Health from "@rat-king/lexicon/mailbox.nameHealth";
import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { DateTime, Effect, Option, Schema } from "effect";

import { PayloadJson } from "../../../packages/mailbox-client/src/payload.ts";
import { failure } from "./failure.ts";
import type { Sql } from "./sqlite.ts";
import { Lease, storageOperation } from "./store.ts";

const Row = Schema.Struct({ value: Schema.String });

const Harness = Schema.Struct({
  harness: Schema.Struct({
    paneId: Schema.optionalKey(Schema.String),
    sessionId: Schema.optionalKey(Schema.String),
  }),
});

const closedOutput = Schema.Struct(Health.Output.schema.fields);

const wakeOf = Effect.fn("Mailbox.wakeOf")(function* wakeOf(
  sql: Sql,
  receipt: Defs.ReceiptValue,
  name: string,
  legacy: boolean
) {
  if (receipt.woke !== undefined) {
    return Option.some({
      quiet: !receipt.woke && receipt.wakeReason !== "data",
      woke: receipt.woke,
    });
  }

  if (!legacy) {
    return Option.none<{ readonly quiet: boolean; readonly woke: boolean }>();
  }

  const rows = yield* storageOperation(() => [
    ...sql.exec(
      "SELECT json_extract(value,'$.envelope') AS value FROM messages WHERE sender=? AND tid=?",
      receipt.message.senderDid,
      receipt.message.messageId
    ),
  ]);

  const [row] = rows;

  if (row === undefined) {
    return Option.none<{ readonly quiet: boolean; readonly woke: boolean }>();
  }

  const encoded = yield* Schema.decodeUnknownEffect(Row)(row);

  const envelope = yield* Schema.decodeEffect(
    Schema.fromJsonString(Defs.EncryptedEnvelope)
  )(encoded.value);

  const payload = yield* plaintextBody(envelope).pipe(
    Effect.flatMap(Schema.decodeEffect(PayloadJson)),
    Effect.option
  );

  if (Option.isNone(payload)) {
    return Option.none<{ readonly quiet: boolean; readonly woke: boolean }>();
  }

  const { value } = payload;

  const woke =
    value.kind === "ask" ||
    (value.kind !== "data" &&
      value.quiet !== true &&
      !(value.cc ?? []).includes(name));

  return Option.some({ quiet: !woke && value.kind !== "data", woke });
});

const leaseOf = (lease: typeof Lease.Type): typeof Health.Lease.Encoded => {
  const harness = Option.getOrUndefined(
    Schema.decodeUnknownOption(Harness)(lease)
  );

  let result: typeof Health.Lease.Encoded = {
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(lease.expiresAt)),
    generation: lease.generation,
    holder: harness?.harness.sessionId ?? lease.leaseId,
  };

  if (harness?.harness.paneId !== undefined) {
    result = { ...result, pane: harness.harness.paneId };
  }

  return result;
};

export const nameHealth = Effect.fn("Mailbox.nameHealth")(
  function* nameHealth(
    sql: Sql,
    params: Health.ParamsValue,
    issuer: string,
    operators: readonly string[]
  ) {
    if (!operators.includes(issuer)) {
      return yield* failure("Forbidden", 403);
    }

    const rows = yield* storageOperation(() =>
      sql.transaction(() => ({
        ack: [
          ...sql.exec(
            "SELECT json_extract(value,'$.current.recordedAt') AS value FROM messages WHERE json_extract(value,'$.current.state')='acked' AND json_type(value,'$.current.recordedAt')='text' ORDER BY json_extract(value,'$.current.recordedAt') DESC LIMIT 1"
          ),
        ],
        lease: [...sql.exec("SELECT value FROM lease WHERE singleton=1")],
        unacked: Array.from(
          sql.exec(
            "SELECT json_extract(value,'$.current') AS value FROM messages WHERE json_extract(value,'$.current.state') IN ('accepted','queued','delivered') ORDER BY json_extract(value,'$.current.state'),json_extract(value,'$.admission.seq') ASC LIMIT 10001"
          ),
          (row) =>
            Schema.decodeUnknownSync(Schema.fromJsonString(Defs.Receipt))(
              Schema.decodeUnknownSync(Row)(row).value
            )
        ),
      }))
    );

    let complete = rows.unacked.length <= 10_000;
    let oldest: Defs.ReceiptValue | undefined;
    let quietUnacked = 0;
    let legacyRemaining = 128;

    for (const receipt of rows.unacked.slice(0, 10_000)) {
      const intent = Option.getOrUndefined(
        yield* wakeOf(sql, receipt, params.name, legacyRemaining > 0)
      );

      const woke = intent?.woke;
      const time = Date.parse(receipt.recordedAt ?? "");

      if (receipt.woke === undefined) {
        legacyRemaining -= 1;
      }

      if (intent?.quiet === true) {
        quietUnacked += 1;
      }

      if (woke === undefined || (woke && !Number.isFinite(time))) {
        complete = false;
      }

      if (
        woke === true &&
        Number.isFinite(time) &&
        (oldest === undefined || time < Date.parse(oldest.recordedAt ?? ""))
      ) {
        oldest = receipt;
      }
    }

    const [leaseRow] = rows.lease;
    const [ackRow] = rows.ack;
    let result: typeof closedOutput.Encoded = { complete, quietUnacked };

    if (ackRow !== undefined) {
      const ack = yield* Schema.decodeUnknownEffect(Row)(ackRow);
      result = { ...result, lastAck: ack.value };
    }

    if (leaseRow !== undefined) {
      const row = yield* Schema.decodeUnknownEffect(Row)(leaseRow);

      const lease = yield* Schema.decodeEffect(Schema.fromJsonString(Lease))(
        row.value
      );

      result = { ...result, lease: leaseOf(lease) };
    }

    if (oldest?.recordedAt !== undefined) {
      result = {
        ...result,
        oldestWake: {
          id: oldest.message.messageId,
          recordedAt: oldest.recordedAt,
          sender: oldest.message.senderDid,
          woke: true,
        },
      };
    }

    return yield* Schema.decodeEffect(closedOutput)(result);
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((error) =>
        Schema.is(XrpcFailure)(error)
          ? error
          : failure("MailboxUnavailable", 503)
      )
    )
);
