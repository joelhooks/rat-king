/* oxlint-disable eslint/max-classes-per-file, eslint/no-redeclare -- Effect service and Schema contracts share their owning port. */
import { Context, Effect, Schema } from "effect";

export const MODEL = "claude-opus-5-5";

export class SidecarFailure extends Schema.TaggedError<SidecarFailure>()(
  "SidecarFailure",
  {
    reason: Schema.String,
  }
) {}

const ToolCall = Schema.Struct({
  function: Schema.Struct({ arguments: Schema.String, name: Schema.String }),
  id: Schema.String,
  type: Schema.Literal("function"),
});

export const ChatRequest = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      content: Schema.optionalKey(Schema.NullOr(Schema.String)),
      role: Schema.Literals([
        "system",
        "developer",
        "user",
        "assistant",
        "tool",
      ]),
      tool_call_id: Schema.optionalKey(Schema.String),
      tool_calls: Schema.optionalKey(Schema.Array(ToolCall)),
    })
  ),
  model: Schema.String,
  stream: Schema.Literal(true),
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        function: Schema.Struct({
          description: Schema.optionalKey(Schema.String),
          name: Schema.String,
          parameters: Schema.Record(Schema.String, Schema.Unknown),
        }),
        type: Schema.Literal("function"),
      })
    )
  ),
});

export type ChatRequest = typeof ChatRequest.Type;

export type ToolCall = typeof ToolCall.Type;

export interface Turn {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly claudePid: number | undefined;
  readonly text: string;
  readonly calls: readonly ToolCall[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const requireModel = Effect.fn("Sidecar.requireModel")(
  function* requireModel(model: string) {
    if (model !== MODEL) {
      return yield* new SidecarFailure({
        reason: `Unsupported model: ${model}`,
      });
    }

    return true;
  }
);

export class ModelDriver extends Context.Service<
  ModelDriver,
  {
    readonly turn: (
      request: ChatRequest
    ) => Effect.Effect<Turn, SidecarFailure>;
  }
>()("claude-sidecar/ModelDriver") {}
