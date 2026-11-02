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

export const ThreadDelivery = Schema.Struct({
  copy: Schema.optionalKey(Schema.Boolean),
  delegatedTo: Schema.optionalKey(Schema.String),
  digestMinutes: Schema.optionalKey(Schema.Finite),
  noReply: Schema.optionalKey(Schema.Boolean),
  quiet: Schema.optionalKey(Schema.Boolean),
});

const deliveryOf = (inbound: Inbound): typeof ThreadDelivery.Type => {
  const delivery: typeof ThreadDelivery.Type = {};

  for (const key of [
    "copy",
    "delegatedTo",
    "digestMinutes",
    "noReply",
    "quiet",
  ] as const) {
    if (inbound[key] !== undefined) {
      Object.assign(delivery, { [key]: inbound[key] });
    }
  }

  return delivery;
};

export const ThreadForward = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.thread#message"),
  delivery: Schema.optionalKey(ThreadDelivery),
  original: RelayRecord,
  reply: Schema.optionalKey(ReplyRef),
  router: Schema.optionalKey(AgentName),
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
  inbound.delegatedTo !== undefined ||
  inbound.kind === "data" ||
  inbound.noReply === true ||
  inbound.askSummary !== undefined ||
  (threadKey(inbound) === inbound.id && Option.isNone(inbound.replyTo)) ||
  new RegExp(`(?:^|\\s)@${config.name}(?=\\s|[.,:!?]|$)`, "u").test(
    `${Option.getOrElse(inbound.summary, () => "")}\n${inbound.body}`
  );

export const projectThread = (
  ownName: string,
  inbound: InboundRecord
): Option.Option<Inbound> => {
  if (!inbound.verified) {
    return Option.none();
  }

  return Schema.decodeUnknownOption(ThreadForward)(inbound.record).pipe(
    Option.filter(
      (record) =>
        record.original.kind !== "data" &&
        (record.router === undefined || record.router === inbound.from) &&
        (!record.original.encrypted || inbound.encrypted === true)
    ),
    Option.map((record) => {
      const projected: Inbound = {
        ...relayedInbound(record.original),
        ...record.delivery,
        ccNames: (record.original.ccNames ?? []).filter(
          (name) => name !== inbound.from
        ),
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
  readonly fallback: (
    inbound: Inbound,
    settled: boolean,
    encrypted: boolean,
    redelivered: boolean
  ) => Effect.Effect<void, E>;
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

      if (
        value.op === "claim" &&
        config.owners !== undefined &&
        !config.owners.some((pattern) =>
          pattern.endsWith("/")
            ? inbound.from.startsWith(pattern)
            : inbound.from === pattern
        )
      ) {
        yield* Effect.logWarning("Thread claim refused", {
          owner: inbound.from,
          router: config.name,
          thread: value.thread,
        });

        return false;
      }

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

      if (value.op === "claim") {
        yield* Effect.logInfo("Thread claimed", {
          owner: inbound.from,
          router: config.name,
          thread: value.thread,
        });
      }

      if (value.op === "escalate" || value.op === "handback") {
        yield* ports.fallback(
          controlNotice(inbound, value),
          false,
          inbound.encrypted ?? true,
          false
        );
      }

      return true;
    });

    const receive = Effect.fn("ThreadRouting.receive")(function* receive(
      inbound: Inbound,
      settled: boolean,
      encrypted: boolean,
      redelivered: boolean,
      fallback: ThreadPorts<E>["fallback"]
    ) {
      if (!threadEnabled(config, inbound) || direct(config, inbound)) {
        yield* fallback(inbound, settled, encrypted, redelivered);

        return false;
      }

      const owners = entries.get(threadKey(inbound))?.owners ?? [];

      const record: typeof ThreadForward.Type = {
        $type: "sh.mschf.ratking.thread#message",
        delivery: deliveryOf(inbound),
        original: relayRecord(inbound, encrypted),
        router: config.name,
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

      if (failed) {
        yield* fallback(
          { ...inbound, routedWake: true },
          settled,
          encrypted,
          redelivered
        );

        return false;
      }

      yield* ports.deliver(
        {
          ...inbound,
          copy: true,
          quiet: true,
          routedCopy: true,
          routedWake: false,
        },
        settled
      );

      return true;
    });

    return {
      control: (inbound: InboundRecord) => mutex.withPermit(control(inbound)),
      receive: (
        inbound: Inbound,
        settled: boolean,
        encrypted: boolean,
        redelivered = false,
        fallback = ports.fallback
      ) =>
        mutex.withPermit(
          receive(inbound, settled, encrypted, redelivered, fallback)
        ),
    };
  });
