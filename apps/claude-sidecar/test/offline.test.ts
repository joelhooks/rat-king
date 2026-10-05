// @effect-diagnostics asyncFunction:off -- MemoryStorage methods are upstream Promise boundaries.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { it } from "@effect/vitest";
import { AgentHarness, Input } from "@rat-king/agent-runtime";
import { piDurableLayer } from "@rat-king/agent-runtime/pi-durable";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { add } from "./add.ts";

class OfflineFailure extends Schema.TaggedError<OfflineFailure>()(
  "OfflineFailure",
  { reason: Schema.String }
) {}

it.effect("same harness and add tool settle one faux call with result 5", () =>
  Effect.gen(function* offline() {
    const storage = new MemoryStorage();
    const models = createModels();
    const faux = fauxProvider({ api: "faux" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("add", { a: 2, b: 3 }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("5"),
    ]);
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "add-proof", tools: [add] }));
    yield* Effect.gen(function* settle() {
      const harness = yield* AgentHarness;

      const input = yield* Schema.decodeUnknownEffect(Input)({
        content: "Add 2 and 3",
        requestId: "offline-add-1",
      });

      const id = yield* harness.submit(input);

      const result = yield* harness.wait(id);
      expect(result).toMatchObject({ answer: "5" });

      const conversations = yield* Effect.tryPromise({
        catch: (cause) => new OfflineFailure({ reason: String(cause) }),
        try: async () =>
          await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT),
      });

      const [conversation] = conversations.items;

      if (conversation === undefined) {
        return yield* new OfflineFailure({ reason: "Missing conversation" });
      }

      const entries = yield* Effect.tryPromise({
        catch: (cause) => new OfflineFailure({ reason: String(cause) }),
        try: async () =>
          await storage.scanEntries(
            { conversationId: conversation.id },
            100,
            undefined,
            BACKGROUND_CONTEXT
          ),
      });

      const results = entries.items.filter((entry) =>
        JSON.stringify(entry).includes('"role":"toolResult"')
      );

      expect(results).toHaveLength(1);
      expect(JSON.stringify(results)).toContain('"text":"5"');
      expect(JSON.stringify(results)).not.toContain('"isError":true');
      expect(faux.state.callCount).toBe(2);

      return true;
    }).pipe(
      Effect.provide(
        piDurableLayer(
          storage,
          { models, registry },
          { modelId: "faux-1", provider: "faux" }
        )
      )
    );
  })
);
