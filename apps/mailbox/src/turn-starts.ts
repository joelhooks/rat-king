import { Turn } from "@rat-king/lexicon/turns";
import { Option, Schema } from "effect";

import { PayloadJson } from "../../../packages/mailbox-client/src/payload.ts";
import type { Sql } from "./sqlite.ts";

export const turnStartTable = (sql: Sql) => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS turn_starts (did TEXT NOT NULL, name TEXT NOT NULL, session TEXT NOT NULL, started_ms INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY(did,name,session))"
  );
};

const TurnJson = Schema.fromJsonString(Turn);

export const recordTurnStart = (
  sql: Sql,
  entry: {
    readonly senderDid: string;
    readonly body?: string;
    readonly state: string;
  }
) => {
  if (entry.state !== "accepted" || entry.body === undefined) {
    return;
  }

  const body = Schema.decodeOption(PayloadJson)(entry.body).pipe(
    Option.map((payload) => payload.body),
    Option.getOrElse(() => entry.body ?? "")
  );

  const turn = Schema.decodeOption(TurnJson)(body);

  if (Option.isNone(turn) || turn.value.state !== "working") {
    return;
  }

  const { agent, at, session } = turn.value;
  const time = Date.parse(at);

  if (Number.isFinite(time)) {
    sql.exec(
      "INSERT INTO turn_starts (did,name,session,started_ms,at) VALUES (?,?,?,?,?) ON CONFLICT(did,name,session) DO UPDATE SET started_ms=excluded.started_ms,at=excluded.at WHERE excluded.started_ms > turn_starts.started_ms",
      entry.senderDid,
      agent,
      session,
      time,
      at
    );
  }
};

const Row = Schema.Struct({ at: Schema.String });

export const lastTurnStart = (
  sql: Sql,
  did: string,
  name: string,
  session: string
) => {
  const [row] = [
    ...sql.exec(
      "SELECT at FROM turn_starts WHERE did=? AND name=? AND session=?",
      did,
      name,
      session
    ),
  ];

  return row === undefined ? undefined : Schema.decodeUnknownSync(Row)(row).at;
};
