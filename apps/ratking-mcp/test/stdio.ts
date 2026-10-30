import {
  Deferred,
  Effect,
  Layer,
  Predicate,
  Queue,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { McpProtocol, McpServer } from "effect/ai";

import { registration } from "../src/main.ts";

const Response = Schema.Struct({
  error: Schema.optionalKey(Schema.Json),
  id: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Finite, Schema.Null])
  ),
  result: Schema.optionalKey(Schema.Json),
});

export const stdio = Effect.fn("Test.stdio")(function* stdio(name: string) {
  const input = yield* Queue.unbounded<Uint8Array>();
  const output = yield* Queue.unbounded<string | Uint8Array>();
  const responses = yield* Queue.unbounded<typeof Response.Type>();

  const io = Stdio.layerTest({
    stderr: () => Sink.drain,
    stdin: Stream.fromQueue(input),
    // oxlint-disable-next-line unicorn/no-array-for-each -- This is Effect Sink.forEach, not Array.forEach.
    stdout: () => Sink.forEach((chunk) => Queue.offer(output, chunk)),
  });

  yield* Stream.fromQueue(output).pipe(
    Stream.map((chunk) =>
      Predicate.isString(chunk) ? chunk : new TextDecoder().decode(chunk)
    ),
    Stream.splitLines,
    Stream.mapEffect((line) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Response))(line)
    ),
    Stream.runForEach((response) =>
      response.id === undefined ? Effect.void : Queue.offer(responses, response)
    ),
    Effect.forkScoped
  );
  const ready = yield* Deferred.make<boolean>();
  yield* Effect.gen(function* serve() {
    yield* Layer.build(
      registration(name).pipe(
        Layer.provide(
          McpServer.layerStdio({
            name: "test-ratking",
            protocols: [McpProtocol.v2025_06_18],
            version: "0.1.0",
          }).pipe(Layer.provide(io))
        )
      )
    );
    yield* Deferred.succeed(ready, true);

    return yield* Effect.never;
  }).pipe(Effect.scoped, Effect.forkScoped);
  yield* Deferred.await(ready);
  let id = 0;

  const request = Effect.fn("Test.request")(function* request(
    method: string,
    params: Schema.Json
  ) {
    id += 1;
    yield* Queue.offer(
      input,
      new TextEncoder().encode(
        `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`
      )
    );

    return yield* Queue.take(responses);
  });

  yield* request("initialize", {
    capabilities: {},
    clientInfo: { name: "test-client", version: "1" },
    protocolVersion: "2025-06-18",
  });
  yield* Queue.offer(
    input,
    new TextEncoder().encode(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
    )
  );

  const Result = Schema.Struct({ structuredContent: Schema.Json });

  return {
    call: Effect.fn("Test.call")(function* call(
      tool: string,
      args: Schema.Json = {}
    ) {
      const response = yield* request("tools/call", {
        arguments: args,
        name: tool,
      });

      const result = yield* Schema.decodeUnknownEffect(Result)(response.result);

      return result.structuredContent;
    }),
    request,
  };
});
