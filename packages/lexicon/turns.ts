import { Array as Arr, Schema } from "effect";

import { Main } from "./src/agentgraph.turn.ts";

export const Turn = Main.check(
  Schema.makeFilter(
    (value) =>
      value.turnId.startsWith(`${value.session}:`) &&
      Number.isSafeInteger(
        Number(value.turnId.slice(value.session.length + 1))
      ) &&
      (value.stopReason === undefined || value.state === "done") &&
      (value.reason === undefined ||
        value.state === "blocked" ||
        value.state === "crashed"),
    {
      expected:
        "session:n turnId; stopReason only on done; reason only on blocked or crashed",
    }
  )
);

export type TurnValue = typeof Turn.Type;

export const signedTurn = (
  record: { readonly $type: string },
  sender: string,
  verified: boolean,
  crashAuthority?: {
    readonly senderDid: string;
    readonly alarmDid: string | undefined;
  }
) =>
  Schema.decodeUnknownOption(
    Turn.check(
      Schema.makeFilter(
        (value) =>
          verified &&
          (sender === "operator" ||
            value.agent === sender ||
            (value.state === "crashed" &&
              crashAuthority !== undefined &&
              crashAuthority.senderDid === crashAuthority.alarmDid)),
        {
          expected:
            "verified agent, operator, or configured crash signer for crash records",
        }
      )
    )
  )(record);

const epoch = (record: TurnValue) => Date.parse(record.at);

const ordinal = (record: TurnValue) =>
  Number(record.turnId.slice(record.session.length + 1));

const rank = { blocked: 3, crashed: 4, done: 2, idle: 0, working: 1 };

const stable = (record: TurnValue) =>
  JSON.stringify([
    record.state,
    record.reason,
    record.stopReason,
    record.generation,
  ]);

const comparison = (value: number): -1 | 0 | 1 => {
  if (value < 0) {
    return -1;
  }

  return value > 0 ? 1 : 0;
};

const latest = (records: readonly TurnValue[]) => {
  let n = -1;

  for (const record of records) {
    n = Math.max(n, ordinal(record));
  }

  const current = records.filter((record) => ordinal(record) === n);
  const done = current.some((record) => record.state === "done");

  return Arr.sort(
    current.filter((record) => !done || record.state !== "working"),
    (left: TurnValue, right: TurnValue) =>
      comparison(
        epoch(left) - epoch(right) ||
          rank[left.state] - rank[right.state] ||
          stable(left).localeCompare(stable(right))
      )
  ).at(-1);
};

const foldAgent = (records: readonly TurnValue[]) => {
  const crash = Arr.sort(
    records.filter((record) => record.state === "crashed"),
    (left: TurnValue, right: TurnValue) =>
      comparison(
        (left.generation ?? -1) - (right.generation ?? -1) ||
          epoch(left) - epoch(right) ||
          left.session.localeCompare(right.session)
      )
  ).at(-1);

  const recoveries =
    crash === undefined
      ? records
      : records.filter(
          (record) =>
            (record.state === "idle" || record.state === "working") &&
            epoch(record) > epoch(crash)
        );

  if (crash !== undefined && recoveries.length === 0) {
    return crash;
  }

  const sessions = new Map<string, number>();

  for (const record of recoveries) {
    sessions.set(
      record.session,
      Math.min(sessions.get(record.session) ?? Infinity, epoch(record))
    );
  }

  const session = Arr.sort(
    sessions,
    ([left, leftAt]: SessionAt, [right, rightAt]: SessionAt) =>
      comparison(leftAt - rightAt || left.localeCompare(right))
  ).at(-1)?.[0];

  return latest(
    records.filter(
      (record) => record.session === session && record.state !== "crashed"
    )
  );
};

type SessionAt = readonly [session: string, at: number];

type AgentTurns = readonly [agent: string, turns: TurnValue[]];

export const foldTurns = (
  records: readonly TurnValue[]
): ReadonlyMap<string, TurnValue> => {
  const agents = new Map<string, TurnValue[]>();

  for (const record of records) {
    const prior = agents.get(record.agent) ?? [];
    prior.push(record);
    agents.set(record.agent, prior);
  }

  const folded = new Map<string, TurnValue>();

  for (const [agent, turns] of Arr.sort(
    agents,
    ([left]: AgentTurns, [right]: AgentTurns) =>
      comparison(left.localeCompare(right))
  )) {
    const value = foldAgent(turns);

    if (value !== undefined) {
      folded.set(agent, value);
    }
  }

  return folded;
};
