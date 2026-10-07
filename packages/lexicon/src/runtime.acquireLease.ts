import { Schema } from "effect";

import * as RuntimeLease from "./runtime.lease.ts";
import * as Runtime from "./runtime.ts";

export const Params = Schema.Undefined;

export type ParamsValue = typeof Params.Type;

export const Input = Schema.StructWithRest(
  Schema.Struct({
    did: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    expiresAt: Runtime.lexString({ format: "datetime", type: "string" }).pipe(
      Schema.brand("Lexicon:datetime")
    ),
    generation: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
      )
    ),
    harness: Schema.Union([
      Schema.StructWithRest(
        Schema.Struct({
          $type: Schema.Literal("sh.mschf.ratking.runtime.lease#pi"),
          executionId: Schema.optionalKey(
            Runtime.lexString({
              description: "Optional run inside the bound session.",
              type: "string",
            })
          ),
          paneId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local pane identifier, never a host address.",
              type: "string",
            })
          ),
          sessionId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local session identifier, never identity.",
              type: "string",
            })
          ),
        }),
        [Schema.Record(Schema.String, Runtime.Data)]
      ),
      Schema.StructWithRest(
        Schema.Struct({
          $type: Schema.Literal("sh.mschf.ratking.runtime.lease#claude"),
          executionId: Schema.optionalKey(
            Runtime.lexString({
              description: "Optional run inside the bound session.",
              type: "string",
            })
          ),
          paneId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local pane identifier, never a host address.",
              type: "string",
            })
          ),
          sessionId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local session identifier, never identity.",
              type: "string",
            })
          ),
        }),
        [Schema.Record(Schema.String, Runtime.Data)]
      ),
      Schema.StructWithRest(
        Schema.Struct({
          $type: Schema.Literal("sh.mschf.ratking.runtime.lease#codex"),
          executionId: Schema.optionalKey(
            Runtime.lexString({
              description: "Optional run inside the bound session.",
              type: "string",
            })
          ),
          paneId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local pane identifier, never a host address.",
              type: "string",
            })
          ),
          sessionId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local session identifier, never identity.",
              type: "string",
            })
          ),
        }),
        [Schema.Record(Schema.String, Runtime.Data)]
      ),
      Schema.StructWithRest(
        Schema.Struct({
          $type: Schema.Literal("sh.mschf.ratking.runtime.lease#opencode"),
          executionId: Schema.optionalKey(
            Runtime.lexString({
              description: "Optional run inside the bound session.",
              type: "string",
            })
          ),
          paneId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local pane identifier, never a host address.",
              type: "string",
            })
          ),
          sessionId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local session identifier, never identity.",
              type: "string",
            })
          ),
        }),
        [Schema.Record(Schema.String, Runtime.Data)]
      ),
      Schema.StructWithRest(
        Schema.Struct({
          $type: Schema.Literal("sh.mschf.ratking.runtime.lease#other"),
          executionId: Schema.optionalKey(
            Runtime.lexString({
              description: "Optional run inside the bound session.",
              type: "string",
            })
          ),
          kind: Runtime.lexString({
            description: "Harness adapter identifier.",
            type: "string",
          }),
          paneId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local pane identifier, never a host address.",
              type: "string",
            })
          ),
          sessionId: Schema.optionalKey(
            Runtime.lexString({
              description:
                "Opaque adapter-local session identifier, never identity.",
              type: "string",
            })
          ),
        }),
        [Schema.Record(Schema.String, Runtime.Data)]
      ),
      Runtime.TaggedMap.check(
        Schema.makeFilter(
          (value) =>
            ![
              "sh.mschf.ratking.runtime.lease#pi",
              "sh.mschf.ratking.runtime.lease#claude",
              "sh.mschf.ratking.runtime.lease#codex",
              "sh.mschf.ratking.runtime.lease#opencode",
              "sh.mschf.ratking.runtime.lease#other",
            ].includes(value.$type),
          { expected: "unknown union tag only" }
        )
      ),
    ]),
    leaseId: Schema.optionalKey(
      Runtime.lexString({ format: "tid", type: "string" }).pipe(
        Schema.brand("Lexicon:tid")
      )
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type InputValue = typeof Input.Type;

export const Output = Schema.StructWithRest(
  Schema.Struct({ lease: RuntimeLease.Main }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OutputValue = typeof Output.Type;

export const ErrorBody = Runtime.XrpcErrorBody;

export type ErrorBodyValue = typeof ErrorBody.Type;

export const KnownErrors = [
  "InvalidRequest",
  "AuthRequired",
  "Forbidden",
  "LeaseHeld",
] as const;

export type KnownError = (typeof KnownErrors)[number];

export const isKnownError = (value: string): value is KnownError =>
  KnownErrors.some((name) => name === value);

export const Method = {
  defaults: {},
  error: ErrorBody,
  input: Input,
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.runtime.acquireLease",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.runtime.acquireLease",
} as const;
