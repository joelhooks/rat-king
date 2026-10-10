import { Schema } from "effect";
import type { EventFromLogic } from "xstate";
import { setup } from "xstate";

const Context = Schema.Struct({
  deferred: Schema.String,
  failed: Schema.String,
  retryAt: Schema.Number,
  sha: Schema.String,
  successful: Schema.String,
});

const Empty = Schema.toStandardSchemaV1(Schema.Struct({}));

export const shipMachine = setup({
  schemas: {
    context: Schema.toStandardSchemaV1(Context),
    events: {
      deferred: Schema.toStandardSchemaV1(
        Schema.Struct({ retryAt: Schema.Number })
      ),
      failure: Empty,
      fetchFailed: Empty,
      observed: Schema.toStandardSchemaV1(
        Schema.Struct({ now: Schema.Number, sha: Schema.String })
      ),
      pending: Empty,
      ready: Empty,
      success: Empty,
      tick: Empty,
    },
    input: Schema.toStandardSchemaV1(
      Schema.Struct({
        deferred: Schema.optionalKey(Schema.String),
        failed: Schema.String,
        retryAt: Schema.optionalKey(Schema.Number),
        successful: Schema.String,
      })
    ),
  },
}).createMachine({
  context: ({ input }) => ({
    ...input,
    deferred: input.deferred ?? "",
    retryAt: input.retryAt ?? 0,
    sha: "",
  }),
  id: "ship",
  initial: "idle",
  states: {
    deferred: { on: { tick: { target: "fetching" } } },
    deploying: {
      on: {
        deferred: ({ context, event }) => ({
          context: {
            ...context,
            deferred: context.sha,
            retryAt: event.retryAt,
          },
          target: "deferred",
        }),
        failure: ({ context }) => ({
          context: {
            ...context,
            deferred: "",
            failed: context.sha,
            retryAt: 0,
          },
          target: "failed",
        }),
        success: ({ context }) => ({
          context: {
            ...context,
            deferred: "",
            failed: "",
            retryAt: 0,
            successful: context.sha,
          },
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

          if (event.sha === context.deferred && event.now < context.retryAt) {
            return {
              context: { ...context, sha: event.sha },
              target: "deferred",
            };
          }

          return {
            context: { ...context, deferred: "", retryAt: 0, sha: event.sha },
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
