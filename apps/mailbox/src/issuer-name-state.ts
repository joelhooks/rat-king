import { Schema } from "effect";

import { NameState, Ticket } from "./name-state.ts";
import type { NameStateValue, TicketValue } from "./name-state.ts";
import type { Sql } from "./sqlite.ts";

const StateRow = Schema.Struct({
  ...NameState.fields,
  retirement: Schema.fromJsonString(NameState.fields.retirement),
  seeded: Schema.Literals([0, 1]),
});

export const stateColumns =
  "name_state.did,version,lease_generation AS leaseGeneration,lease_expires_at AS leaseExpiresAt,retirement_json AS retirement,observed_at AS observedAt,seeded";

export const projectionTables = (sql: Sql) => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS name_state (did TEXT PRIMARY KEY, version INTEGER NOT NULL, lease_generation INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL, retirement_json TEXT NOT NULL, observed_at INTEGER NOT NULL, seeded INTEGER NOT NULL CHECK(seeded IN (0,1)))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS name_state_retirement ON name_state(json_extract(retirement_json,'$.name')) WHERE seeded=1 AND retirement_json<>'null'"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pending_ops (did TEXT PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload TEXT NOT NULL, expected_version INTEGER NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pending_ops_due ON pending_ops(next_at,did)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS ticket_drain (singleton INTEGER PRIMARY KEY CHECK(singleton=1), next_at INTEGER NOT NULL)"
  );
};

export const decodeProjection = Schema.decodeUnknownSync(StateRow);

export const seededProjection = ({ seeded, ...state }: typeof StateRow.Type) =>
  seeded === 1 ? state : undefined;

export const observeName = (sql: Sql, state: NameStateValue): number => {
  const retirement = Schema.encodeSync(StateRow.fields.retirement)(
    state.retirement
  );

  sql.exec(
    `INSERT INTO name_state (did,version,lease_generation,lease_expires_at,retirement_json,observed_at,seeded)
    VALUES (?,?,?,?,?,?,1) ON CONFLICT(did) DO UPDATE SET version=excluded.version,
      lease_generation=excluded.lease_generation,lease_expires_at=excluded.lease_expires_at,
      retirement_json=excluded.retirement_json,observed_at=excluded.observed_at,seeded=1
    WHERE excluded.version>name_state.version`,
    state.did,
    state.version,
    state.leaseGeneration,
    state.leaseExpiresAt,
    retirement,
    state.observedAt
  );
  sql.exec(
    `UPDATE name_state SET seeded=0 WHERE did=? AND version=? AND
    (lease_generation<>? OR lease_expires_at<>? OR retirement_json<>?)`,
    state.did,
    state.version,
    state.leaseGeneration,
    state.leaseExpiresAt,
    retirement
  );

  return state.version;
};

const Payload = Schema.fromJsonString(Ticket);

const nextAttempt = (now: number, attempt: number) =>
  now + Math.min(60_000, 2000 * 2 ** attempt);

export const writeTicket = (sql: Sql, ticket: TicketValue, now: number) =>
  [
    ...sql.exec(
      `INSERT INTO pending_ops (did,op_id,kind,payload,expected_version,attempts,next_at)
    VALUES (?,?,?,?,?,1,?) ON CONFLICT(did) DO NOTHING RETURNING op_id`,
      ticket.did,
      ticket.opId,
      ticket.command._tag,
      Schema.encodeSync(Payload)(ticket),
      ticket.expectedVersion,
      nextAttempt(now, 0)
    ),
  ].length === 1;

const Drain = Schema.Struct({ next_at: Schema.Int });

const Due = Schema.Struct({ attempts: Schema.Int, payload: Payload });

export const claimDueTickets = (sql: Sql, now: number) => {
  const [last] = sql.exec("SELECT next_at FROM ticket_drain WHERE singleton=1");

  if (
    last !== undefined &&
    Schema.decodeUnknownSync(Drain)(last).next_at > now
  ) {
    return [];
  }

  sql.exec(
    "INSERT INTO ticket_drain VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET next_at=excluded.next_at",
    now + 5000
  );

  const due = Array.from(
    sql.exec(
      "SELECT payload,attempts FROM pending_ops WHERE next_at<=? ORDER BY next_at,did LIMIT 16",
      now
    ),
    (row) => Schema.decodeUnknownSync(Due)(row)
  );

  for (const { payload, attempts } of due) {
    sql.exec(
      "UPDATE pending_ops SET attempts=MIN(attempts+1,8),next_at=? WHERE op_id=?",
      nextAttempt(now, attempts),
      payload.opId
    );
  }

  return due.map(({ payload }) => payload);
};

export const finishTicket = (sql: Sql, ticket: TicketValue) =>
  [
    ...sql.exec(
      "DELETE FROM pending_ops WHERE did=? AND op_id=? RETURNING op_id",
      ticket.did,
      ticket.opId
    ),
  ].length === 1;
