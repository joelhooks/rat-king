import { Schema } from "effect";
import type { EventFromLogic } from "xstate";
import { setup } from "xstate";

const Context = Schema.Struct({
  failed: Schema.String,
  sha: Schema.String,
  successful: Schema.String,
});

const Empty = Schema.toStandardSchemaV1(Schema.Struct({}));

export const shipMachine = setup({
  schemas: {
    context: Schema.toStandardSchemaV1(Context),
    events: {
      deferred: Empty,
      failure: Empty,
      fetchFailed: Empty,
      observed: Schema.toStandardSchemaV1(
        Schema.Struct({ sha: Schema.String })
      ),
      pending: Empty,
      ready: Empty,
      success: Empty,
      tick: Empty,
    },
    input: Schema.toStandardSchemaV1(
      Schema.Struct({ failed: Schema.String, successful: Schema.String })
    ),
  },
}).createMachine({
  context: ({ input }) => ({ ...input, sha: "" }),
  id: "ship",
  initial: "idle",
  states: {
    deploying: {
      on: {
        deferred: { target: "idle" },
        failure: ({ context }) => ({
          context: { ...context, failed: context.sha },
          target: "failed",
        }),
        success: ({ context }) => ({
          context: { ...context, failed: "", successful: context.sha },
          target: "idle",
        }),
      },
    },
    failed: { on: { tick: { target: "fetching" } } },
    fetching: {
      on: {
        fetchFailed: { target: "failed" },
        observed: ({ context, event }) => {
          if (event.sha === context.failed) {
            return {
              context: { ...context, sha: event.sha },
              target: "failed",
            };
          }

          if (event.sha === context.successful) {
            return { context: { ...context, sha: event.sha }, target: "idle" };
          }

          return {
            context: { ...context, sha: event.sha },
            target: "waiting-ci",
          };
        },
      },
    },
    idle: { on: { tick: { target: "fetching" } } },
    "waiting-ci": {
      on: {
        pending: { target: "waiting-ci" },
        ready: { target: "deploying" },
        tick: { target: "fetching" },
      },
    },
  },
});

export type ShipEvent = EventFromLogic<typeof shipMachine>;
