/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- DO RPC, provider streams and upstream storage are Promise boundaries. */
// @effect-diagnostics asyncFunction:off -- Durable Object and upstream SDK adapter.
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { DurableObject } from "cloudflare:workers";
import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Option,
  Schema,
} from "effect";
import type { Scope } from "effect";

import { journalSqlite } from "./journal-sqlite.ts";
import {
  AgentJournal,
  AgentKeys,
  AgentMailbox,
  drainMailbox,
} from "./mailbox-loop.ts";
import type { LoopKeys, LoopMailbox } from "./mailbox-loop.ts";
import { ModelAccess, modelGatewayLayer } from "./model-access.ts";
import { originFetch } from "./model-egress.ts";
import { piDurableLayer } from "./pi-durable.ts";
import { HarnessFailure } from "./port.ts";
import { durableSqlite } from "./sqlite.ts";

export interface HostedBindings {
  readonly HOSTED_AGENTS: string;
  readonly AGENT_IDENTITIES_CREDENTIAL: string;
  readonly AGENT_MODEL: string;
  readonly MODEL_GATEWAY_BASE_URL?: string;
  readonly MODEL_GATEWAY_CREDENTIAL?: string;
  readonly MODEL_GATEWAY_MODEL?: string;
  readonly CLAUDE_SIDECAR_BASE_URL?: string;
  readonly CLAUDE_SIDECAR_CREDENTIAL?: string;
}

const PrivateKey = Schema.Struct({
  crv: Schema.Literal("P-256"),
  d: Schema.String,
  kty: Schema.Literal("EC"),
  x: Schema.String,
  y: Schema.String,
});

const Identity = Schema.Struct({
  agreement: PrivateKey,
  did: Schema.String,
  signing: PrivateKey,
});

const Identities = Schema.Array(Identity);

const guardedModelLayer = (env: HostedBindings, outbound: typeof fetch) =>
  Layer.effect(
    ModelAccess,
    Effect.gen(function* guardedModel() {
      const mode = yield* Config.String("AGENT_MODEL");

      if (mode === "faux") {
        if (
          env.MODEL_GATEWAY_BASE_URL !== undefined ||
          env.MODEL_GATEWAY_CREDENTIAL !== undefined ||
          env.CLAUDE_SIDECAR_BASE_URL !== undefined ||
          env.CLAUDE_SIDECAR_CREDENTIAL !== undefined
        ) {
          return yield* new HarnessFailure({
            operation: "configure",
            reason: "Faux mode forbids gateway bindings",
          });
        }

        const models = createModels();
        const faux = fauxProvider({ api: "faux" });
        models.setProvider(
          createProvider({
            api: {
              stream: (model, context, options) => {
                faux.setResponses([fauxAssistantMessage("Faux agent answer.")]);

                return faux.provider.stream(model, context, options);
              },
              streamSimple: (model, context, options) => {
                faux.setResponses([fauxAssistantMessage("Faux agent answer.")]);

                return faux.provider.streamSimple(model, context, options);
              },
            },
            auth: faux.provider.auth,
            id: faux.provider.id,
            models: faux.provider.getModels(),
            name: faux.provider.name,
          })
        );

        return ModelAccess.of({
          model: { modelId: "faux-1", provider: "faux" },
          models,
        });
      }

      if (mode !== "gateway") {
        return yield* new HarnessFailure({
          operation: "configure",
          reason: "Unknown agent model mode",
        });
      }

      const access = yield* ModelAccess.pipe(
        Effect.provide(modelGatewayLayer())
      );

      const provider = access.models.getProvider(access.model.provider);

      const baseUrl =
        access.model.provider === "claude-sidecar"
          ? env.CLAUDE_SIDECAR_BASE_URL
          : env.MODEL_GATEWAY_BASE_URL;

      if (!provider || baseUrl === undefined) {
        return yield* new HarnessFailure({
          operation: "configure",
          reason: "Missing gateway provider",
        });
      }

      const fetch = originFetch(baseUrl, outbound);
      const models = createModels();
      models.setProvider(
        createProvider({
          api: {
            stream: (model, context, options) =>
              provider.stream(model, context, { ...options, fetch }),
            streamSimple: (model, context, options) =>
              provider.streamSimple(model, context, { ...options, fetch }),
          },
          auth: provider.auth,
          id: provider.id,
          models: provider.getModels(),
          name: provider.name,
        })
      );

      return ModelAccess.of({ model: access.model, models });
    })
  );

export interface HostedAdapter<Env extends HostedBindings> {
  readonly mailbox: (
    env: Env,
    did: string,
    signing: CryptoKey
  ) => Effect.Effect<LoopMailbox, HarnessFailure, Scope.Scope>;
  readonly resolve: (env: Env) => LoopKeys["resolve"];
  readonly outbound: typeof fetch;
}

export const makeHostedAgent = <Env extends HostedBindings>(
  adapter: HostedAdapter<Env>
) =>
  class HostedAgent extends DurableObject<Env> {
    private readonly database = durableSqlite({
      sql: this.ctx.storage.sql,
      transaction: (operation) => this.ctx.storage.transaction(operation),
    });
    private readonly runtime = this.open();
    private tail: Promise<void> = Promise.resolve();

    private async open() {
      const storage = await SqliteStorage.open(this.database);
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS agent_loop (request_id TEXT PRIMARY KEY, value TEXT NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS agent_loop_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
      );
      const { env } = this;

      return ManagedRuntime.make(
        Layer.unwrap(
          Effect.gen(function* hostedHarness() {
            const access = yield* ModelAccess;

            return piDurableLayer(
              storage,
              {
                models: access.models,
                registry: createRegistry(),
                settings: {
                  retry: { baseDelayMs: 0, enabled: false, maxRetries: 0 },
                  stream: { maxRetries: 0, timeoutMs: 45_000 },
                },
              },
              access.model,
              {
                thinkingLevel: access.model.provider === "faux" ? "off" : "low",
              },
              true
            );
          })
        ).pipe(
          Layer.provide(guardedModelLayer(env, adapter.outbound)),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
        )
      );
    }

    private readonly keys = Effect.gen({ self: this }, function* agentKeys() {
      const identities = yield* Config.Redacted("AGENT_IDENTITIES_CREDENTIAL");
      const hosted = yield* Config.String("HOSTED_AGENTS");
      const did = this.ctx.id.name;

      const hosts = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(Schema.String))
      )(hosted);

      if (did === undefined || !hosts.includes(did)) {
        return yield* new HarnessFailure({
          operation: "identity",
          reason: "Agent DID is not hosted",
        });
      }

      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Identities)
      )(Redacted.value(identities));

      const identity = parsed.find((entry) => entry.did === did);

      if (!identity) {
        return yield* new HarnessFailure({
          operation: "identity",
          reason: "Missing agent identity binding",
        });
      }

      return AgentKeys.of({
        agreement: yield* cryptoOperation(() =>
          crypto.subtle.importKey(
            "jwk",
            identity.agreement,
            { name: "ECDH", namedCurve: "P-256" },
            true,
            ["deriveBits"]
          )
        ),
        did,
        resolve: adapter.resolve(this.env),
        signing: yield* cryptoOperation(() =>
          crypto.subtle.importKey(
            "jwk",
            identity.signing,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["sign"]
          )
        ),
      });
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(this.env)))
    );

    private readonly journal = journalSqlite(this.database);

    private async drain(previous: Promise<void>): Promise<void> {
      await previous;

      try {
        const runtime = await this.runtime;
        await runtime.runPromise(
          Effect.gen({ self: this }, function* drain() {
            const keys = yield* this.keys;

            return yield* drainMailbox().pipe(
              Effect.provide([
                Layer.succeed(AgentKeys, keys),
                Layer.succeed(AgentJournal, this.journal),
                Layer.effect(
                  AgentMailbox,
                  adapter.mailbox(this.env, keys.did, keys.signing)
                ),
              ]),
              Effect.scoped
            );
          }).pipe(
            Effect.tapCause((cause) =>
              Effect.sync(() => {
                const error = Cause.findErrorOption(cause);

                const tag =
                  Option.isSome(error) &&
                  Schema.is(Schema.Struct({ _tag: Schema.String }))(error.value)
                    ? error.value._tag
                    : "Defect";

                const operation =
                  Option.isSome(error) && Schema.is(HarnessFailure)(error.value)
                    ? error.value.operation
                    : tag;

                this.ctx.storage.sql.exec(
                  "INSERT INTO agent_loop_meta VALUES ('diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  operation
                );
              })
            )
          )
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO agent_loop_meta VALUES ('last_drain','done') ON CONFLICT(key) DO UPDATE SET value='done'"
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO agent_loop_meta VALUES ('completed','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)"
        );
      } catch {
        this.ctx.storage.sql.exec(
          "INSERT INTO agent_loop_meta VALUES ('last_drain','failed') ON CONFLICT(key) DO UPDATE SET value='failed'"
        );
      }
    }

    wake(): Promise<void> {
      this.tail = this.drain(this.tail);
      this.ctx.waitUntil(this.tail);

      return Promise.resolve();
    }

    evidence() {
      return {
        completed: [
          ...this.ctx.storage.sql.exec(
            "SELECT value FROM agent_loop_meta WHERE key='completed'"
          ),
        ],
        diagnostic: [
          ...this.ctx.storage.sql.exec(
            "SELECT value FROM agent_loop_meta WHERE key='diagnostic'"
          ),
        ],
        drain: [
          ...this.ctx.storage.sql.exec(
            "SELECT value FROM agent_loop_meta WHERE key='last_drain'"
          ),
        ],
        journal: [
          ...this.ctx.storage.sql.exec(
            "SELECT request_id, value FROM agent_loop ORDER BY request_id"
          ),
        ],
        submissions: [
          ...this.ctx.storage.sql.exec(
            "SELECT id FROM submissions ORDER BY id"
          ),
        ],
      };
    }
  };
