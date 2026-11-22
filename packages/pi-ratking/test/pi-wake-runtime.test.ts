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
import { Deferred, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { expect, vi } from "vitest";

import { asPiExtension, ratkingExtension } from "../src/extension.ts";
import { shownIds } from "../src/pending.ts";
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

const proveWake = (source: "mail" | "watch", quietBody: string) =>
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
        noTools: "builtin",
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
      })
    );

    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue();

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
    yield* deliver({ ...mail("quiet"), body: quietBody, quiet: true }, false);
    yield* deliver({ ...mail("copy"), cc: true }, false);
    expect(prompt).not.toHaveBeenCalled();
    expect(session.isStreaming).toBe(false);

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
  "the installed Pi starts no run for held mail and carries it into both a mail wake and a watch wake",
  [Schema.String],
  ([body]) =>
    proveWake("mail", body).pipe(
      Effect.andThen(proveWake("watch", body)),
      Effect.provide(NodeServices.layer),
      Effect.timeout("8 seconds")
    ),
  { arbitrary: { runs: 3 }, timeout: 30_000 }
);
