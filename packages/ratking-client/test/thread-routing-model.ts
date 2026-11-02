import { Effect, Function as Fn, Option, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { attend } from "../src/attend.ts";
import type { ThreadRoutingValue } from "../src/config.ts";
import type { Inbound, InboundRecord } from "../src/payload.ts";
import { openThreadRouting } from "../src/thread-routing.ts";
import type { ThreadEntry } from "../src/thread-routing.ts";

const Peer = Schema.Literals(["alpha", "beta", "gamma"]);

const Thread = Schema.Literals(["root-a", "root-b"]);

export const Step = Schema.Struct({
  action: Schema.Literals([
    "claim",
    "release",
    "handback",
    "escalate",
    "event",
    "restart",
  ]),
  encrypted: Schema.Boolean,
  failure: Schema.Literals(["none", "alpha", "beta", "gamma", "all"]),
  kind: Schema.Literals(["ask", "message", "reply"]),
  peer: Peer,
  thread: Thread,
  variant: Schema.Literals(["normal", "direct", "new", "operator"]),
  verified: Schema.Boolean,
});

export const Mode = Schema.Literals(["sender", "thread", "off", "all"]);

interface Model {
  readonly owners: Map<string, Set<string>>;
}

const did = (name: string) => `did:web:${name}.example.invalid`;

export const inbound = (thread: string, id = "event"): Inbound => ({
  body: "follow-up",
  cc: false,
  did: did("sender"),
  from: "sender",
  id,
  kind: "message",
  label: Option.none(),
  replyTo: Option.none(),
  summary: Option.none(),
  thread,
  to: "router",
  verified: true,
});

const setupStep = (
  action: (typeof Step.Type)["action"],
  peer: typeof Peer.Type,
  thread: typeof Thread.Type
): typeof Step.Type => ({
  action,
  encrypted: true,
  failure: "none",
  kind: "ask",
  peer,
  thread,
  variant: "normal",
  verified: true,
});

const seeds = (["root-a", "root-b"] as const).flatMap((thread) => [
  setupStep("claim", "alpha", thread),
  setupStep("claim", "beta", thread),
  setupStep("claim", "gamma", thread),
  setupStep("event", "alpha", thread),
]);

const final = (["root-a", "root-b"] as const).flatMap((thread) => [
  setupStep("release", "alpha", thread),
  setupStep("handback", "beta", thread),
  setupStep("release", "gamma", thread),
  setupStep("event", "alpha", thread),
]);

const setup = () => ({
  model: { owners: new Map<string, Set<string>>() },
  real: undefined,
});

export const ownershipModel = Effect.fn("Test.ownershipModel")(
  function* runOwnershipModel(
    mode: typeof Mode.Type,
    steps: readonly (typeof Step.Type)[]
  ) {
    const context = yield* Effect.context();
    const config: ThreadRoutingValue = { name: "router" };

    if (mode !== "all") {
      Object.assign(config, { senders: mode === "sender" ? ["sender"] : [] });
    }

    if (mode === "thread") {
      Object.assign(config, { threads: ["root-a"] });
    }

    let journal: readonly ThreadEntry[] = [];
    let failed = "none";
    let sequence = 0;
    const deliveries: Inbound[] = [];
    const forwards: { name: string; id: string; encrypted: boolean }[] = [];

    const open = () =>
      openThreadRouting(config, {
        deliver: (message) =>
          Effect.sync(() => {
            deliveries.push(message);
          }),
        forward: (owner, record, encrypted) =>
          Effect.gen(function* forwardEvent() {
            forwards.push({
              encrypted,
              id: record.original.id,
              name: owner.name,
            });
            expect(record.original.encrypted).toBe(encrypted);

            if (failed === "all" || failed === owner.name) {
              return yield* Effect.fail("unreachable");
            }

            return yield* Effect.void;
          }),
        load: Effect.sync(() => journal),
        save: (entries) =>
          Effect.sync(() => {
            journal = entries;
          }),
      });

    let router = yield* open();

    const applyControl = (
      step: typeof Step.Type,
      owners: Set<string>,
      model: Model
    ) =>
      Effect.gen(function* checkControl() {
        const accepted = step.verified;

        const notice =
          accepted &&
          (step.action === "escalate" || step.action === "handback");

        const control: InboundRecord = {
          did: did(step.peer),
          from: step.peer,
          id: `control-${sequence}`,
          record: {
            $type: "sh.mschf.ratking.thread#control",
            op: step.action,
            thread: step.thread,
          },
          replyTo: Option.none(),
          verified: step.verified,
        };

        expect(yield* router.control(control)).toBe(accepted);
        expect(deliveries).toHaveLength(notice ? 1 : 0);

        if (accepted && step.action === "claim") {
          owners.add(step.peer);
        } else if (accepted && step.action !== "escalate") {
          owners.delete(step.peer);
        }

        model.owners.set(step.thread, owners);
        expect(
          journal
            .find((entry) => entry.thread === step.thread)
            ?.owners.map((owner) => owner.name)
            .toSorted() ?? []
        ).toEqual([...owners].toSorted());

        if (notice) {
          expect(
            attend(
              deliveries[0] ?? inbound(step.thread),
              {},
              0,
              undefined,
              Option.none()
            )._tag
          ).toBe("Now");
        }
      });

    const applyEvent = (step: typeof Step.Type, owners: Set<string>) =>
      Effect.gen(function* checkEvent() {
        const message: Inbound = {
          ...inbound(step.thread, `event-${sequence}`),
          kind: step.kind,
          verified: step.verified,
        };

        if (step.variant === "direct") {
          Object.assign(message, { body: "@router make a decision" });
        }

        if (step.variant === "new") {
          Object.assign(message, { thread: message.id });
        }

        if (step.variant === "operator") {
          Object.assign(message, { from: "operator" });
        }

        const enabled =
          step.verified &&
          (mode === "all" ||
            (mode === "sender" && step.variant !== "operator") ||
            (mode === "thread" && step.thread === "root-a"));

        const pass = enabled && step.variant === "normal";
        const recipients = pass ? [...owners].toSorted() : [];

        const failure =
          recipients.length === 0 ||
          recipients.some(
            (name) => step.failure === "all" || step.failure === name
          );

        yield* router.receive(message, false, step.encrypted);
        expect(forwards.map((entry) => entry.name).toSorted()).toEqual(
          recipients
        );
        expect(
          forwards.every(
            (entry) =>
              entry.id === message.id && entry.encrypted === step.encrypted
          )
        ).toBe(true);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.body).toBe(message.body);
        expect(
          attend(deliveries[0] ?? message, {}, 0, undefined, Option.none())._tag
        ).toBe(failure ? "Now" : "Next");
      });

    const commands: AsyncCommand<Model, undefined>[] = [
      ...seeds,
      ...steps,
      ...final,
    ].map((step) => ({
      check: () => true,
      run: Fn.flow(
        (model: Model) =>
          Effect.gen(function* applyCommand() {
            sequence += 1;
            failed = step.failure;
            deliveries.length = 0;
            forwards.length = 0;

            if (step.action === "restart") {
              router = yield* open();

              return;
            }

            const owners = model.owners.get(step.thread) ?? new Set<string>();

            yield* step.action === "event"
              ? applyEvent(step, owners)
              : applyControl(step, owners, model);
          }),
        Effect.runPromiseWith(context)
      ),
      toString: () => JSON.stringify(step),
    }));

    yield* Effect.promise(asyncModelRun.bind(null, setup, commands));
  }
);
