import { Schema } from "effect";
import type { EventFromLogic } from "xstate";
import { setup } from "xstate";

import { PreparedRetries } from "./ship-config.ts";

const backoffBase = 60;

const backoffCap = 3600;

const Context = Schema.Struct({
  deferred: Schema.String,
  failed: Schema.String,
  failedGate: Schema.String,
  fetchFailures: Schema.Int,
  fetchRetryAt: Schema.Number,
  preparedAhead: Schema.Array(Schema.String),
  preparedRetries: PreparedRetries,
  retryAt: Schema.Number,
  sha: Schema.String,
  successful: Schema.String,
});

const Empty = Schema.toStandardSchemaV1(Schema.Struct({}));

const keepRetries = (
  context: typeof Context.Type,
  allowed: readonly string[]
) => {
  const retries = { ...context.preparedRetries };

  if (context.deferred !== "") {
    retries[context.deferred] = context.retryAt;
  }

  return Object.fromEntries(
    Object.entries(retries).filter(([sha]) => allowed.includes(sha))
  );
};

export const shipMachine = setup({
  schemas: {
    context: Schema.toStandardSchemaV1(Context),
    events: {
      deferred: Schema.toStandardSchemaV1(
        Schema.Struct({ retryAt: Schema.Number })
      ),
      failure: Schema.toStandardSchemaV1(
        Schema.Struct({ gate: Schema.String })
      ),
      fetchFailed: Schema.toStandardSchemaV1(
        Schema.Struct({ now: Schema.Number })
      ),
      notReady: Empty,
      observed: Schema.toStandardSchemaV1(
        Schema.Struct({ now: Schema.Number, sha: Schema.String })
      ),
      pending: Empty,
      prepared: Schema.toStandardSchemaV1(
        Schema.Struct({
          ahead: Schema.Array(Schema.String),
          sha: Schema.String,
        })
      ),
      ready: Empty,
      success: Empty,
      tick: Schema.toStandardSchemaV1(Schema.Struct({ now: Schema.Number })),
    },
    input: Schema.toStandardSchemaV1(
      Schema.Struct({
        deferred: Schema.optionalKey(Schema.String),
        failed: Schema.String,
        failedGate: Schema.optionalKey(Schema.String),
        preparedRetries: Schema.optionalKey(PreparedRetries),
        retryAt: Schema.optionalKey(Schema.Number),
        successful: Schema.String,
      })
    ),
  },
}).createMachine({
  context: ({ input }) => ({
    ...input,
    deferred: input.deferred ?? "",
    failedGate: input.failedGate ?? "",
    fetchFailures: 0,
    fetchRetryAt: 0,
    preparedAhead: [],
    preparedRetries: input.preparedRetries ?? {},
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
            preparedRetries:
              context.preparedAhead.length > 0
                ? { ...context.preparedRetries, [context.sha]: event.retryAt }
                : context.preparedRetries,
            retryAt: event.retryAt,
          },
          target: "deferred",
        }),
        failure: ({ context, event }) => ({
          context: {
            ...context,
            deferred: "",
            failed: context.sha,
            failedGate: event.gate,
            retryAt: 0,
          },
          target: "failed",
        }),
        success: ({ context }) => ({
          context: {
            ...context,
            deferred: "",
            failed: "",
            failedGate: "",
            preparedRetries:
              context.preparedAhead.length > 0
                ? keepRetries(
                    context,
                    context.preparedAhead.slice(
                      0,
                      context.preparedAhead.indexOf(context.sha)
                    )
                  )
                : context.preparedRetries,
            retryAt: 0,
            successful: context.sha,
          },
          target: "idle",
        }),
      },
    },
    failed: { on: { tick: { target: "fetching" } } },
    "fetch-error": {
      on: {
        tick: ({ context, event }) => ({
          context,
          target: event.now < context.fetchRetryAt ? "fetch-error" : "fetching",
        }),
      },
    },
    fetching: {
      on: {
        fetchFailed: ({ context, event }) => {
          const fetchFailures = context.fetchFailures + 1;

          return {
            context: {
              ...context,
              fetchFailures,
              fetchRetryAt:
                event.now +
                Math.min(backoffCap, backoffBase * 2 ** (fetchFailures - 1)),
            },
            target: "fetch-error",
          };
        },
        notReady: ({ context }) => ({
          context: { ...context, sha: "" },
          target: "waiting-ci",
        }),
        observed: ({ context: prior, event }) => {
          const context = { ...prior, fetchFailures: 0, fetchRetryAt: 0 };

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
        prepared: ({ context, event }) => ({
          context: {
            ...context,
            deferred: "",
            fetchFailures: 0,
            fetchRetryAt: 0,
            preparedAhead: event.ahead,
            preparedRetries: keepRetries(
              context,
              event.ahead.filter((sha) => sha !== event.sha)
            ),
            retryAt: 0,
            sha: event.sha,
          },
          target: "waiting-ci",
        }),
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
