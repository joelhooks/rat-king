import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export const Claude = Schema.StructWithRest(
  Schema.Struct({
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
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string",
      })
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ClaudeValue = typeof Claude.Type;

export const Codex = Schema.StructWithRest(
  Schema.Struct({
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
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string",
      })
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type CodexValue = typeof Codex.Type;

export const Main = Schema.StructWithRest(
  Schema.Struct({
    did: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    expiresAt: Runtime.lexString({ format: "datetime", type: "string" }).pipe(
      Schema.brand("Lexicon:datetime")
    ),
    generation: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
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
    issuedAt: Schema.optionalKey(
      Runtime.lexString({ format: "datetime", type: "string" }).pipe(
        Schema.brand("Lexicon:datetime")
      )
    ),
    leaseId: Runtime.lexString({ format: "tid", type: "string" }).pipe(
      Schema.brand("Lexicon:tid")
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type MainValue = typeof Main.Type;

export const Opencode = Schema.StructWithRest(
  Schema.Struct({
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
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string",
      })
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OpencodeValue = typeof Opencode.Type;

export const Other = Schema.StructWithRest(
  Schema.Struct({
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
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string",
      })
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OtherValue = typeof Other.Type;

export const Pi = Schema.StructWithRest(
  Schema.Struct({
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
        description: "Opaque adapter-local session identifier, never identity.",
        type: "string",
      })
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type PiValue = typeof Pi.Type;
