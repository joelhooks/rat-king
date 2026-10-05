import * as Defs from "@rat-king/lexicon/defs";
import { createMachine, transition } from "xstate";

export const delivery = createMachine({
  context: {},
  id: "delivery",
  initial: "accepted",
  states: {
    accepted: {
      on: {
        expire: { target: "expired" },
        fail: { target: "failed" },
        queue: { target: "queued" },
      },
    },
    acked: { type: "final" },
    delivered: {
      on: {
        ack: { target: "acked" },
        expire: { target: "expired" },
        fail: { target: "failed" },
        inject: { target: "delivered" },
      },
    },
    expired: { type: "final" },
    failed: { type: "final" },
    queued: {
      on: {
        expire: { target: "expired" },
        fail: { target: "failed" },
        inject: { target: "delivered" },
      },
    },
  },
});

export type DeliveryCommand = "queue" | "inject" | "ack" | "expire" | "fail";

export const advance = (
  state: Defs.DeliveryStateKnown,
  command: DeliveryCommand
) => {
  const [next] = transition(
    delivery,
    delivery.resolveState({ context: {}, value: state }),
    { type: command }
  );

  return Defs.isDeliveryStateKnown(next.value) ? next.value : state;
};
