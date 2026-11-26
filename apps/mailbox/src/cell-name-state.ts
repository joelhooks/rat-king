import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Schema } from "effect";

import { failure } from "./failure.ts";
import {
  NameCommand,
  NameState,
  TicketOutcome,
  TicketReply,
} from "./name-state.ts";
import type {
  NameStateValue,
  TicketReplyValue,
  TicketValue,
} from "./name-state.ts";
import { markRetired, repointRetirement } from "./retirement.ts";
import type { Sql } from "./sqlite.ts";
import type { Transaction } from "./store.ts";

const Row = Schema.Struct({ value: Schema.String });

const StateJson = Schema.fromJsonString(NameState);

const ReplyJson = Schema.fromJsonString(TicketReply);

export const cellNameTables = (sql: Sql) => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS name_revision (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, observed_at INTEGER NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS name_outbox (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, value TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS name_ticket_receipt (singleton INTEGER PRIMARY KEY CHECK(singleton=1), op_id TEXT NOT NULL, value TEXT NOT NULL)"
  );
};

const Revision = Schema.Struct({ observedAt: Schema.Int, version: Schema.Int });

export const standingState = (sql: Sql, tx: Transaction): NameStateValue => {
  const [row] = sql.exec(
    "SELECT version, observed_at AS observedAt FROM name_revision WHERE singleton=1"
  );

  const revision =
    row === undefined
      ? { observedAt: 0, version: 0 }
      : Schema.decodeUnknownSync(Revision)(row);

  const lease = tx.lease();

  return {
    ...revision,
    did: tx.recipient(),
    leaseExpiresAt: lease?.expiresAt ?? 0,
    leaseGeneration: lease?.generation ?? 0,
    retirement: tx.retirement() ?? null,
  };
};

export const writeNameState = (sql: Sql, tx: Transaction, now: number) => {
  const previous = standingState(sql, tx);
  const state = { ...previous, observedAt: now, version: previous.version + 1 };
  const json = Schema.encodeSync(StateJson)(state);
  sql.exec(
    "INSERT INTO name_revision VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version, observed_at=excluded.observed_at",
    state.version,
    now
  );
  sql.exec(
    "INSERT INTO name_outbox VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version, value=excluded.value",
    state.version,
    json
  );

  return state;
};

export const pendingNameState = (sql: Sql) => {
  const [row] = sql.exec("SELECT value FROM name_outbox WHERE singleton=1");

  return row === undefined
    ? undefined
    : Schema.decodeUnknownSync(StateJson)(
        Schema.decodeUnknownSync(Row)(row).value
      );
};

export const ackNameState = (sql: Sql, version: number) => {
  sql.exec("DELETE FROM name_outbox WHERE singleton=1 AND version<=?", version);
};

const saveReceipt = (sql: Sql, opId: string, reply: TicketReplyValue) => {
  sql.exec(
    "INSERT INTO name_ticket_receipt VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET op_id=excluded.op_id, value=excluded.value",
    opId,
    Schema.encodeSync(ReplyJson)(reply)
  );

  return reply;
};

export const applyNameTicket = (
  sql: Sql,
  tx: Transaction,
  ticket: TicketValue,
  documents: readonly { readonly id: string }[],
  now: number,
  stage: () => NameStateValue
): TicketReplyValue => {
  const state = standingState(sql, tx);

  if (state.did !== ticket.did) {
    throw failure("Forbidden", 403);
  }

  const [receipt] = sql.exec(
    "SELECT value FROM name_ticket_receipt WHERE singleton=1 AND op_id=?",
    ticket.opId
  );

  if (receipt !== undefined) {
    const reply = Schema.decodeUnknownSync(ReplyJson)(
      Schema.decodeUnknownSync(Row)(receipt).value
    );

    if (reply.state.version === state.version) {
      return reply;
    }
  }

  if (state.version !== ticket.expectedVersion) {
    return { outcome: TicketOutcome.cases.Superseded.make({}), state };
  }

  let cleared = false;

  try {
    NameCommand.match(ticket.command, {
      Clear: () => {
        tx.setRetirement(undefined);
        cleared = state.retirement !== null;
      },
      Repoint: (command) => {
        repointRetirement(tx, command.successor, command.updatedAt);
      },
      Retire: (command) => {
        markRetired(
          tx,
          documents,
          command.retirement,
          command.holderMayRetire,
          now
        );
      },
    });
  } catch (error) {
    if (
      !Schema.is(XrpcFailure)(error) ||
      (error.error !== "NameNotFound" &&
        error.error !== "LeaseLive" &&
        error.error !== "NotRetired")
    ) {
      throw error;
    }

    const reply: TicketReplyValue = {
      outcome: TicketOutcome.cases.Refused.make({
        error: error.error,
        message: error.message ?? error.error,
      }),
      state,
    };

    return saveReceipt(sql, ticket.opId, reply);
  }

  return saveReceipt(sql, ticket.opId, {
    outcome: TicketOutcome.cases.Applied.make({ cleared }),
    state: stage(),
  });
};
