import { Effect, Option, Schema, Semaphore } from "effect";
import { createMachine, transition } from "xstate";

import { ReplyRef } from "../../mailbox-client/src/payload.ts";
import { isOperator } from "./attend.ts";
import type { ThreadRoutingValue } from "./config.ts";
import { AgentName, Did } from "./name.ts";
import type { Inbound, InboundRecord } from "./payload.ts";
import { RelayRecord, relayedInbound, relayRecord } from "./relay.ts";

export const ThreadOperation = Schema.Literals([
  "claim",
  "release",
  "handback",
  "escalate",
]);

export const ThreadControl = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.thread#control"),
  message: Schema.optionalKey(Schema.String),
  op: ThreadOperation,
  thread: Schema.NonEmptyString,
});

export const ThreadForward = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.thread#message"),
  original: RelayRecord,
  reply: Schema.optionalKey(ReplyRef),
  thread: Schema.NonEmptyString,
});

const Owner = Schema.Struct({ did: Did, name: AgentName });

const Entry = Schema.Struct({
  owners: Schema.Array(Owner),
  state: Schema.Literals(["unowned", "owned", "released", "handedBack"]),
  thread: Schema.NonEmptyString,
});

export const ThreadJournal = Schema.Array(Entry);

export type ThreadEntry = typeof Entry.Type;

export const threadLifecycle = createMachine({
  context: {},
  id: "thread-ownership",
  initial: "unowned",
  states: {
    handedBack: {
      on: { claim: { target: "owned" }, release: { target: "released" } },
    },
    owned: {
      on: {
        claim: { target: "owned" },
        handback: { target: "handedBack" },
        release: { target: "released" },
      },
    },
    released: {
      on: { claim: { target: "owned" }, handback: { target: "handedBack" } },
    },
    unowned: {
      on: {
        claim: { target: "owned" },
        handback: { target: "handedBack" },
        release: { target: "released" },
      },
    },
  },
});

export const threadKey = (inbound: Inbound) =>
  inbound.thread ??
  inbound.reply?.root ??
  Option.getOrElse(inbound.replyTo, () => inbound.id);

export const threadEnabled = (config: ThreadRoutingValue, inbound: Inbound) =>
  inbound.verified &&
  (config.senders?.includes(inbound.from) === true ||
    config.threads?.includes(threadKey(inbound)) === true ||
    (config.senders === undefined && config.threads === undefined));

const direct = (config: ThreadRoutingValue, inbound: Inbound) =>
  isOperator(inbound) ||
  inbound.threadRouter !== undefined ||
  inbound.copy === true ||
  inbound.kind === "data" ||
  inbound.noReply === true ||
  inbound.askSummary !== undefined ||
  (threadKey(inbound) === inbound.id && Option.isNone(inbound.replyTo)) ||
  new RegExp(`(?:^|\\s)@${config.name}(?=\\s|[.,:!?]|$)`, "u").test(
    `${Option.getOrElse(inbound.summary, () => "")}\n${inbound.body}`
  );

export const projectThread = (
  routers: readonly ThreadRoutingValue[],
  ownName: string,
  inbound: InboundRecord
): Option.Option<Inbound> => {
  if (
    !inbound.verified ||
    !routers.some((router) => router.name === inbound.from)
  ) {
    return Option.none();
  }

  return Schema.decodeUnknownOption(ThreadForward)(inbound.record).pipe(
    Option.filter(
      (record) =>
        record.original.kind !== "data" &&
        (!record.original.encrypted || inbound.encrypted === true)
    ),
    Option.map((record) => {
      const projected: Inbound = {
        ...relayedInbound(record.original),
        cc: false,
        ccNames: (record.original.ccNames ?? []).filter(
          (name) => name !== inbound.from
        ),
        copy: false,
        quiet: false,
        routedWake: true,
        thread: record.thread,
        threadRouter: {
          did: inbound.did,
          encrypted: record.original.encrypted,
          name: inbound.from,
        },
        to: ownName,
      };

      if (record.reply !== undefined) {
        Object.assign(projected, { reply: record.reply });
      }

      return projected;
    })
  );
};

export interface ThreadPorts<E> {
  readonly load: Effect.Effect<readonly ThreadEntry[], E>;
  readonly save: (entries: readonly ThreadEntry[]) => Effect.Effect<void, E>;
  readonly forward: (
    owner: typeof Owner.Type,
    record: typeof ThreadForward.Type,
    encrypted: boolean
  ) => Effect.Effect<void, E>;
  readonly deliver: (inbound: Inbound, settled: boolean) => Effect.Effect<void>;
}

const nextEntry = (
  previous: ThreadEntry,
  control: typeof ThreadControl.Type,
  sender: typeof Owner.Type
): ThreadEntry => {
  const others = previous.owners.filter((owner) => owner.did !== sender.did);
  const owners = control.op === "claim" ? [...others, sender] : others;
  const event = control.op === "handback" ? "handback" : "release";

  const [next] = transition(
    threadLifecycle,
    threadLifecycle.resolveState({ context: {}, value: previous.state }),
    { type: control.op === "claim" || owners.length > 0 ? "claim" : event }
  );

  return {
    owners,
    state: Schema.decodeUnknownSync(Entry.fields.state)(next.value),
    thread: previous.thread,
  };
};

const controlNotice = (
  inbound: InboundRecord,
  control: typeof ThreadControl.Type
): Inbound => ({
  body:
    control.message ??
    `Thread ${control.thread}: ${inbound.from} ${control.op}`,
  cc: false,
  did: inbound.did,
  from: inbound.from,
  id: inbound.id,
  kind: "message",
  label: Option.none(),
  replyTo: inbound.replyTo,
  routedWake: true,
  summary: Option.none(),
  thread: control.thread,
  verified: true,
});

export const openThreadRouting = <E>(
  config: ThreadRoutingValue,
  ports: ThreadPorts<E>
) =>
  Effect.gen(function* openOwners() {
    const mutex = yield* Semaphore.make(1);

    const entries = new Map(
      (yield* ports.load).map((entry) => [entry.thread, entry])
    );

    const control = Effect.fn("ThreadRouting.control")(function* control(
      inbound: InboundRecord
    ) {
      const decoded = Schema.decodeUnknownOption(ThreadControl)(inbound.record);

      if (
        !inbound.verified ||
        inbound.from === config.name ||
        Option.isNone(decoded)
      ) {
        return false;
      }

      const { value } = decoded;

      const previous = entries.get(value.thread) ?? {
        owners: [],
        state: "unowned",
        thread: value.thread,
      };

      if (value.op !== "escalate") {
        const next = nextEntry(previous, value, {
          did: inbound.did,
          name: inbound.from,
        });

        yield* ports.save([
          ...[...entries.values()].filter(
            (entry) => entry.thread !== value.thread
          ),
          next,
        ]);
        entries.set(value.thread, next);
      }

      if (value.op === "escalate" || value.op === "handback") {
        yield* ports.deliver(controlNotice(inbound, value), false);
      }

      return true;
    });

    const receive = Effect.fn("ThreadRouting.receive")(function* receive(
      inbound: Inbound,
      settled: boolean,
      encrypted: boolean
    ) {
      if (!threadEnabled(config, inbound) || direct(config, inbound)) {
        yield* ports.deliver({ ...inbound, routedWake: true }, settled);

        return;
      }

      const owners = entries.get(threadKey(inbound))?.owners ?? [];

      const record: typeof ThreadForward.Type = {
        $type: "sh.mschf.ratking.thread#message",
        original: relayRecord(inbound, encrypted),
        thread: threadKey(inbound),
      };

      if (inbound.reply !== undefined) {
        Object.assign(record, { reply: inbound.reply });
      }

      let failed = owners.length === 0;

      for (const owner of owners) {
        const accepted = yield* ports.forward(owner, record, encrypted).pipe(
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("Thread owner forward failed; router will wake", {
              id: inbound.id,
              owner: owner.name,
            }).pipe(Effect.as(false))
          )
        );

        failed ||= !accepted;
      }

      yield* ports.deliver(
        failed
          ? { ...inbound, routedWake: true }
          : {
              ...inbound,
              copy: true,
              quiet: true,
              routedCopy: true,
              routedWake: false,
            },
        settled
      );
    });

    return {
      control: (inbound: InboundRecord) => mutex.withPermit(control(inbound)),
      receive: (inbound: Inbound, settled: boolean, encrypted: boolean) =>
        mutex.withPermit(receive(inbound, settled, encrypted)),
    };
  });
