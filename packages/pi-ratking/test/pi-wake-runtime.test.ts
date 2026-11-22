import { promisify } from "node:util";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import type { Deliver } from "@rat-king/ratking-client/ratking";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { expect, vi } from "vitest";

import { asPiExtension, ratkingExtension } from "../src/extension.ts";
import { MAIL_HOLD_MS, shownIds, shownInHistory } from "../src/pending.ts";
import { harness } from "./harness.ts";

const mail = (id: string): Inbound => ({
  body: `body ${id}`,
  cc: false,
  did: "sender",
  from: "sender",
  id,
  kind: "message",
  label: Option.none(),
  replyTo: Option.none(),
  summary: Option.none(),
  verified: true,
});

const wakeInPi = (api: ExtensionAPI) => {
  api.sendMessage(
    { content: "watch completed", customType: "watch-result", display: true },
    { deliverAs: "followUp", triggerTurn: true }
  );
};

const ownerCopy = (id: string): Inbound => ({
  ...mail(id),
  cc: true,
  copy: true,
  levers: { enabled: true, owner: "sender" },
});

const proveWake = (
  source: "mail" | "watch" | "typed" | "single",
  quietBody: string
) =>
  Effect.gen(function* actualPiWake() {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const ready = yield* Deferred.make<Deliver>();

    const extension = ratkingExtension({
      facts: (session) =>
        Effect.succeed({
          alive: () => true,
          env: Option.some("tester"),
          pane: Option.none(),
          pid: 1,
          session,
        }),
      layer: Layer.merge(
        harness(
          cwd,
          HttpClient.make(() => Effect.die("Unexpected request"))
        ),
        Layer.mock(RatKing, {
          run: (_facts, handler) =>
            Deferred.succeed(ready, handler).pipe(Effect.asVoid),
        })
      ),
      tool: Effect.succeed("ratking"),
    });

    const settingsManager = SettingsManager.inMemory();
    const eventBus = createEventBus();

    const loader = new DefaultResourceLoader({
      agentDir: cwd,
      cwd,
      eventBus,
      extensionFactories: [
        (pi) => {
          pi.events.on("test.watch", () => {
            wakeInPi(pi);
          });
        },
        asPiExtension(extension),
      ],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
    });

    yield* Effect.promise(loader.reload.bind(loader, {}));

    const { session } = yield* Effect.promise(
      createAgentSession.bind(undefined, {
        agentDir: cwd,
        cwd,
        model: {
          api: "openai-completions",
          baseUrl: "",
          contextWindow: 16_384,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
          id: "fixture",
          input: ["text"],
          maxTokens: 1024,
          name: "Fixture",
          provider: "openai",
          reasoning: false,
        },
        noTools: "builtin",
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
      })
    );

    const prompt = vi.spyOn(session.agent, "prompt");

    if (source !== "typed") {
      prompt.mockResolvedValue();
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(
        session.extensionRunner.emit.bind(session.extensionRunner, {
          reason: "quit",
          type: "session_shutdown",
        })
      ).pipe(Effect.ensuring(Effect.sync(session.dispose.bind(session))))
    );
    yield* Effect.promise(
      session.bindExtensions.bind(session, { mode: "tui" })
    );

    const deliver = yield* Deferred.await(ready);

    if (source === "single") {
      vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
      const body = `${quietBody}${"x".repeat(5000)}plaintext-tail`;
      yield* deliver(
        { ...mail("quiet"), body, encrypted: false, quiet: true },
        false,
        undefined,
        () => true
      );
      expect(prompt).not.toHaveBeenCalled();
      yield* Effect.promise(
        session.prompt.bind(session, "read my context", {})
      );
      const sent = prompt.mock.calls[0]?.[0];

      const messages = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            content: Schema.Unknown,
            customType: Schema.optional(Schema.String),
            details: Schema.optional(Schema.Unknown),
            role: Schema.String,
          })
        )
      )(sent);

      expect(
        messages.some(
          (item) =>
            item.role === "custom" &&
            Schema.is(Schema.String)(item.content) &&
            item.content.includes(body)
        )
      ).toBe(true);
      expect(
        messages.flatMap((item) =>
          shownIds({
            role: item.role,
            ...(item.customType === undefined
              ? undefined
              : { customType: item.customType }),
            details: item.details,
          })
        )
      ).toEqual(["quiet"]);

      return;
    }

    const body =
      source === "typed"
        ? `${quietBody}${"x".repeat(5000)}encrypted-tail`
        : quietBody;

    yield* deliver(
      { ...mail("quiet"), body, encrypted: true, quiet: true },
      false
    );
    yield* deliver(ownerCopy("copy"), false);
    expect(prompt).not.toHaveBeenCalled();
    expect(session.isStreaming).toBe(false);

    if (source === "typed") {
      const streaming = yield* Deferred.make<boolean>();
      const gate = { resume: () => {} };

      const pause = promisify((resume: () => void) => {
        gate.resume = resume;
        Deferred.doneUnsafe(streaming, Effect.succeed(true));
      });

      let first = true;

      const requests = vi.fn(() => {
        const message: AssistantMessage = {
          api: "openai-completions",
          content: first
            ? [
                {
                  arguments: { action: "status" },
                  id: "fixture-call",
                  name: "ratking",
                  type: "toolCall",
                },
              ]
            : [{ text: "fixture finished", type: "text" }],
          model: "fixture",
          provider: "openai",
          role: "assistant",
          stopReason: first ? "toolUse" : "stop",
          timestamp: 1,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: {
              cacheRead: 0,
              cacheWrite: 0,
              input: 0,
              output: 0,
              total: 0,
            },
            input: 1,
            output: 1,
            totalTokens: 2,
          },
        };

        first = false;

        const stream = createAssistantMessageEventStream();
        stream.push({
          message,
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          type: "done",
        });

        return stream;
      });

      const stopWatching = session.agent.subscribe(
        (event): Promise<void> | undefined =>
          event.type === "message_end" &&
          shownIds(event.message).includes("copy")
            ? pause()
            : undefined
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopWatching();
          gate.resume();
        })
      );

      vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
      session.agent.streamFunction = requests;
      delete session.agent.getApiKey;
      delete session.agent.prepareRequest;

      const sends = vi.spyOn(session, "sendCustomMessage");

      const run = yield* Effect.promise(
        session.prompt.bind(session, "typed prompt", {})
      ).pipe(Effect.forkScoped);

      yield* Effect.raceFirst(
        Deferred.await(streaming),
        Fiber.join(run).pipe(
          Effect.andThen(Effect.die("Prompt stopped before the fixture stream"))
        )
      );
      expect(session.isStreaming).toBe(true);
      const entries = session.sessionManager.getEntries();
      expect(shownInHistory(entries)).toEqual(new Set(["quiet", "copy"]));
      expect(
        entries.some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "ratking_message" &&
            Schema.is(Schema.String)(entry.content) &&
            entry.content.includes(body)
        )
      ).toBe(true);

      const now = yield* Clock.currentTimeMillis;

      const expiry = (ms: number) =>
        DateTime.formatIso(DateTime.makeUnsafe(now + ms));

      const before = sends.mock.calls.length;

      yield* deliver(
        { ...ownerCopy("far"), expiresAt: expiry(MAIL_HOLD_MS * 3) },
        false
      );
      expect(sends).toHaveBeenCalledTimes(before);
      yield* deliver(
        { ...ownerCopy("near"), expiresAt: expiry(MAIL_HOLD_MS / 2) },
        false
      );
      expect(sends).toHaveBeenCalledTimes(before + 1);
      expect(sends.mock.calls.at(-1)?.[1]).toEqual({
        deliverAs: "followUp",
        triggerTurn: false,
      });
      expect(session.agent.hasQueuedMessages()).toBe(false);
      gate.resume();
      yield* Fiber.join(run);
      expect(requests).toHaveBeenCalledTimes(2);
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
      expect(shownInHistory(session.sessionManager.getEntries())).toEqual(
        new Set(["quiet", "copy", "near", "far"])
      );

      return;
    }

    yield* source === "mail"
      ? deliver(mail("direct"), false)
      : Effect.sync(() => {
          eventBus.emit("test.watch", {});
        });

    yield* Effect.promise(session.waitForIdle.bind(session));
    expect(prompt).toHaveBeenCalledTimes(1);

    const messages = prompt.mock.calls[0]?.[0];
    expect(Array.isArray(messages) ? messages.flatMap(shownIds) : []).toEqual(
      source === "mail" ? ["direct", "quiet", "copy"] : ["quiet", "copy"]
    );
  }).pipe(Effect.scoped);

it.live.prop(
  "the installed Pi holds owner cc without a wake while idle or streaming, bypassing only near expiry without another request",
  [Schema.String],
  ([body]) =>
    proveWake("mail", body).pipe(
      Effect.andThen(proveWake("watch", body)),
      Effect.andThen(proveWake("typed", body)),
      Effect.andThen(proveWake("single", body)),
      Effect.provide(NodeServices.layer),
      Effect.timeout("8 seconds")
    ),
  { arbitrary: { runs: 3 }, timeout: 30_000 }
);
