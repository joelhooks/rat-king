import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Worker fetch and upstream tools are Promise interfaces. */
// @effect-diagnostics asyncFunction:off -- Test-only Worker and tool SDK boundaries.
// @effect-diagnostics newPromise:off -- The blocked tool deliberately waits until the owned process is killed.
import { DurableObject } from "cloudflare:workers";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Schema } from "effect";
/* oxlint-disable promise/avoid-new, eslint/no-empty-function -- The crash fixture intentionally holds a replay-safe tool until process death. */

import { modelGatewayLayer, ModelAccess } from "../src/model-access.ts";
import { piDurableLayer } from "../src/pi-durable.ts";
import { AgentHarness, Input, SubmissionId } from "../src/port.ts";
import { durableSqlite } from "../src/sqlite.ts";

interface Bindings {
  readonly AGENT: DurableObjectNamespace<Agent>;
  readonly MODEL_GATEWAY_BASE_URL?: string;
  readonly MODEL_GATEWAY_CREDENTIAL?: string;
  readonly MODEL_GATEWAY_MODEL?: string;
}

const Flag = Schema.Struct({ value: Schema.Int });

const response: FauxResponseFactory = (transcript) => {
  const last = transcript.messages.at(-1);

  if (last?.role === "toolResult") {
    return fauxAssistantMessage("resumed answer");
  }

  if (last?.role === "user" && last.content === "slow") {
    return fauxAssistantMessage(
      fauxToolCall("restart_gate", {}, { id: "crash-call" }),
      { stopReason: "toolUse" }
    );
  }

  return fauxAssistantMessage("ordinary answer");
};

export class Agent extends DurableObject<Bindings> {
  private readonly database = durableSqlite({
    sql: this.ctx.storage.sql,
    transaction: (operation) => this.ctx.storage.transaction(operation),
  });

  private readonly faux = fauxProvider({
    api: "faux",
    tokenSize: { max: 100, min: 100 },
  });

  private readonly runtime = this.open();

  private async open() {
    await this.database.exec(
      "CREATE TABLE IF NOT EXISTS proof (key TEXT PRIMARY KEY, value INTEGER NOT NULL)"
    );

    if (this.env.MODEL_GATEWAY_BASE_URL !== undefined) {
      const storage = await SqliteStorage.open(this.database);

      return ManagedRuntime.make(
        Layer.unwrap(
          Effect.gen(function* modelHarness() {
            const access = yield* ModelAccess;

            return piDurableLayer(
              storage,
              {
                models: access.models,
                registry: createRegistry(),
                settings: {
                  retry: { baseDelayMs: 0, enabled: false, maxRetries: 0 },
                  stream: { maxRetries: 0, timeoutMs: 60_000 },
                },
              },
              access.model,
              {
                thinkingLevel:
                  access.model.modelId === "claude-opus-5-5" ? "off" : "low",
              }
            );
          })
        ).pipe(
          Layer.provide(modelGatewayLayer()),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                MODEL_GATEWAY_BASE_URL: this.env.MODEL_GATEWAY_BASE_URL,
                MODEL_GATEWAY_CREDENTIAL: this.env.MODEL_GATEWAY_CREDENTIAL,
                MODEL_GATEWAY_MODEL:
                  this.ctx.id.name?.startsWith("model:") === true
                    ? this.ctx.id.name.slice(6)
                    : (this.env.MODEL_GATEWAY_MODEL ?? "gpt-6-sol"),
              })
            )
          )
        )
      );
    }

    const models = createModels();

    const { faux } = this;

    const registry = createRegistry();

    const tool = defineTool({
      description: "Wait for the crash proof restart gate",
      execute: async () => {
        await this.database.run(
          "INSERT INTO proof VALUES ('entered',1) ON CONFLICT(key) DO UPDATE SET value=1"
        );

        const flag = await this.database.get(
          "SELECT value FROM proof WHERE key='release'"
        );

        if (!flag || Schema.decodeUnknownSync(Flag)(flag).value !== 1) {
          await new Promise<void>(() => {});
        }

        return { content: [{ text: "released", type: "text" }] };
      },
      name: "restart_gate",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      replay: "safe",
    });

    registry.install(defineExtension({ name: "crash-proof", tools: [tool] }));

    faux.setResponses(Array.from({ length: 8 }, () => response));
    models.setProvider(faux.provider);
    const storage = await SqliteStorage.open(this.database);

    return ManagedRuntime.make(
      piDurableLayer(
        storage,
        { models, registry },
        { modelId: "faux-1", provider: "faux" }
      )
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const runtime = await this.runtime;
    const url = new URL(request.url);

    if (url.pathname === "/release") {
      await this.database.run(
        "INSERT INTO proof VALUES ('release',1) ON CONFLICT(key) DO UPDATE SET value=1"
      );
    }

    await runtime.runPromise(
      Effect.gen(function* resume() {
        const harness = yield* AgentHarness;
        yield* harness.resume();
      })
    );

    if (url.pathname === "/submit") {
      const input = Schema.decodeUnknownSync(Input)(await request.json());

      const id = await runtime.runPromise(
        Effect.gen(function* submit() {
          return yield* (yield* AgentHarness).submit(input);
        })
      );

      return Response.json({ id, requestId: input.requestId });
    }

    if (url.pathname === "/wait" || url.pathname === "/release") {
      const id = Schema.decodeUnknownSync(SubmissionId)(
        Number(url.searchParams.get("id"))
      );

      const settled = await runtime.runPromise(
        Effect.gen(function* wait() {
          return yield* (yield* AgentHarness).wait(id);
        })
      );

      return Response.json(settled);
    }

    const entered = await this.database.get(
      "SELECT value FROM proof WHERE key='entered'"
    );

    const entries = await this.database.all(
      "SELECT * FROM entries ORDER BY id"
    );

    const tasks = await this.database.all("SELECT * FROM tasks ORDER BY id");

    const submissions = await this.database.all(
      "SELECT * FROM submissions ORDER BY id"
    );

    const usage = await this.database.all(
      "SELECT content AS record FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE json_extract(record, '$.kind') = 'pi.usage') AND kind = 'base' ORDER BY seq DESC LIMIT 1"
    );

    return Response.json({
      calls: this.faux.state.callCount,
      entered,
      entries,
      submissions,
      tasks,
      usage,
    });
  }
}

export default {
  fetch: async (request: Request, env: Bindings) => {
    if (new URL(request.url).pathname === "/idle") {
      return new Response("idle");
    }

    const name =
      env.MODEL_GATEWAY_BASE_URL === undefined
        ? "proof"
        : `model:${new URL(request.url).searchParams.get("model") ?? env.MODEL_GATEWAY_MODEL ?? "gpt-6-sol"}`;

    return await env.AGENT.getByName(name).fetch(request);
  },
};
