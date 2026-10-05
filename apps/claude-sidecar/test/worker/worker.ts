/* oxlint-disable typescript/promise-function-async -- Worker and pi-durable tools are Promise interfaces. */
// @effect-diagnostics asyncFunction:off -- Worker and tool SDK boundaries.
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { AgentHarness, Input, SubmissionId } from "@rat-king/agent-runtime";
import {
  ModelAccess,
  modelGatewayLayer,
} from "@rat-king/agent-runtime/model-access";
import { piDurableLayer } from "@rat-king/agent-runtime/pi-durable";
import { durableSqlite } from "@rat-king/agent-runtime/sqlite";
import { DurableObject } from "cloudflare:workers";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Schema } from "effect";

import { add } from "../add.ts";

interface Bindings {
  readonly AGENT: DurableObjectNamespace<Agent>;
  readonly SIDECAR_BASE: string;
  readonly SIDECAR_CREDENTIAL: string;
}

export class Agent extends DurableObject<Bindings> {
  private readonly database = durableSqlite({
    sql: this.ctx.storage.sql,
    transaction: (operation) => this.ctx.storage.transaction(operation),
  });
  private readonly runtime = this.open();

  private async open() {
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "add-proof",
        tools: [add],
      })
    );
    const storage = await SqliteStorage.open(this.database);

    return ManagedRuntime.make(
      Layer.unwrap(
        Effect.gen(function* harnessLayer() {
          const access = yield* ModelAccess;

          return piDurableLayer(
            storage,
            {
              models: access.models,
              registry,
              settings: {
                retry: { baseDelayMs: 0, enabled: false, maxRetries: 0 },
                stream: { maxRetries: 0, timeoutMs: 60_000 },
              },
            },
            access.model
          );
        })
      ).pipe(
        Layer.provide(modelGatewayLayer()),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CLAUDE_SIDECAR_BASE_URL: `${this.env.SIDECAR_BASE}/v1`,
              CLAUDE_SIDECAR_CREDENTIAL: this.env.SIDECAR_CREDENTIAL,
              MODEL_GATEWAY_MODEL: "claude-opus-5-5",
            })
          )
        )
      )
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const runtime = await this.runtime;
    const url = new URL(request.url);

    if (url.pathname === "/submit") {
      const input = Schema.decodeUnknownSync(Input)(await request.json());

      const id = await runtime.runPromise(
        Effect.gen(function* submit() {
          return yield* (yield* AgentHarness).submit(input);
        })
      );

      return Response.json({ id });
    }

    if (url.pathname === "/wait") {
      const id = Schema.decodeUnknownSync(SubmissionId)(
        Number(url.searchParams.get("id"))
      );

      return Response.json(
        await runtime.runPromise(
          Effect.gen(function* wait() {
            return yield* (yield* AgentHarness).wait(id);
          })
        )
      );
    }

    return Response.json({
      entries: await this.database.all("SELECT * FROM entries ORDER BY id"),
      submissions: await this.database.all(
        "SELECT * FROM submissions ORDER BY id"
      ),
    });
  }
}

export default {
  fetch: async (request: Request, env: Bindings) =>
    await env.AGENT.getByName("proof").fetch(request),
};
