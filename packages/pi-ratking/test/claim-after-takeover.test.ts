/* oxlint-disable effect-tests/no-manual-effect-runtime-in-tests -- fast-check commands bridge back into the owning Effect context. */
import { createEventBus } from "@earendil-works/pi-coding-agent";
// @effect-diagnostics asyncFunction:off -- Pi's extension API and fast-check commands are the Promise boundary under test.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import { Directory } from "@rat-king/ratking-client/directory";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  Clock,
  ConfigProvider,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as fc from "fast-check";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { collectFacts, ratkingExtension } from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import type { ToolParamsValue } from "../src/tool.ts";
import { fakeMailbox, quietSocket } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

const idle = async () => {};

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry(
      Schedule.spaced("5 millis").pipe(
        Schedule.while(({ attempt }) => attempt < 1000)
      )
    )
  );

const leaseBody = (did: string, expiresAt: string, session: string) => ({
  lease: {
    did,
    expiresAt,
    generation: 3,
    harness: {
      $type: "sh.mschf.ratking.runtime.lease#pi",
      sessionId: session,
    },
    leaseId: "3mxcx45mn7sex",
  },
});

interface Server {
  acquires: number;
  taken: boolean;
}

const lease = (server: Server) => {
  const mailbox = fakeMailbox("accept");

  const http = HttpClient.make((request) =>
    Effect.gen(function* serve() {
      const nsid = new URL(request.url).pathname;
      const did = new URL(request.url).searchParams.get("did") ?? "";

      const expiresAt = DateTime.formatIso(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 300_000)
      );

      if (
        nsid.endsWith(".acquireLease") &&
        Predicate.isTagged(request.body, "Uint8Array")
      ) {
        server.acquires += 1;

        if (server.taken) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "LeaseHeld" }, { status: 409 })
          );
        }

        const input = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Acquire.Input)
        )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            lease: {
              ...input,
              expiresAt,
              generation: 4,
              leaseId: "3mxcx45mn7sey",
            },
          })
        );
      }

      if (nsid.endsWith(".resolveLease")) {
        return HttpClientResponse.fromWeb(
          request,
          server.taken
            ? Response.json(leaseBody(did, expiresAt, "taker"))
            : Response.json({ error: "LeaseNotFound" }, { status: 404 })
        );
      }

      return yield* mailbox.http.execute(request);
    })
  );

  return { http, mailbox };
};

const Step = Schema.Literals(["take", "release", "claim", "send"]);

type StepValue = typeof Step.Type;

interface Model {
  live: boolean;
  taken: boolean;
}

interface Tool {
  readonly execute: (
    id: string,
    call: ToolParamsValue,
    signal: AbortSignal | undefined,
    update: undefined,
    context: Readonly<Record<string, never>>
  ) => Promise<{
    readonly content: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  }>;
}

const isTool = (value: unknown): value is Tool =>
  Predicate.hasProperty(value, "execute") &&
  Predicate.isFunction(value.execute);

class Command implements fc.AsyncCommand<
  Model,
  (step: StepValue) => Promise<void>
> {
  readonly step: StepValue;

  constructor(step: StepValue) {
    this.step = step;
  }

  check() {
    return this.step.length > 0;
  }

  async run(model: Model, real: (step: StepValue) => Promise<void>) {
    await real(this.step);

    if (this.step === "take") {
      model.taken = true;
    }

    if (this.step === "release") {
      model.taken = false;
    }

    if (this.step === "claim" && !model.live && !model.taken) {
      model.live = true;
    }
  }

  toString() {
    return this.step;
  }
}

it.live.prop(
  "a send-only Pi still sends, and claim recovers its name exactly when the taker has let go",
  [Arbitrary.schema(Schema.Array(Step).check(Schema.isMaxLength(10)))],
  ([steps]) =>
    Effect.gen(function* recovery() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const context = yield* Effect.context();
      const server: Server = { acquires: 0, taken: true };
      const served = lease(server);
      const peer = yield* identity("did:web:peer.agents.example.invalid");
      const peerDocument = yield* document(peer);

      const layer = Layer.effectDiscard(
        Directory.use((directory) =>
          directory.record("peer", peerDocument).pipe(Effect.orDie)
        )
      ).pipe(
        Layer.provideMerge(harness(state, served.http)),
        Layer.provideMerge(quietSocket)
      );

      let started: (start: SessionStart) => Promise<void> = idle;
      let ended: () => Promise<void> = idle;
      let tool: Tool | undefined;

      const pi: PiHost = {
        events: createEventBus(),
        onSessionEnd: (handler) => {
          ended = handler;
        },
        onSessionStart: (handler) => {
          started = handler;
        },
        registerMessageRenderer: () => {},
        registerTool: (definition) => {
          if (isTool(definition)) {
            tool = definition;
          }
        },
        sendMessage: () => {},
      };

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: (session) =>
            Effect.succeed({
              alive: () => false,
              env: Option.some("tester"),
              pane: Option.none(),
              pid: 1,
              session,
            }),
          layer,
          tool: Effect.succeed("ratking"),
        })(pi);

        await startSession(started, {
          interactive: true,
          session: "old",
          warn: () => {},
        });
      });

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await ended();
        })
      );

      const call = async (params: ToolParamsValue) => {
        const result = await tool?.execute(
          "call",
          params,
          undefined,
          undefined,
          {}
        );

        return {
          isError: result?.isError === true,
          text: result?.content.map((part) => part.text ?? "").join("") ?? "",
        };
      };

      const status = Effect.promise(
        async () => await call({ action: "status" })
      );

      yield* eventually(
        status.pipe(
          Effect.filterOrFail((result) =>
            /SEND-ONLY|send-only|held/u.test(result.text)
          )
        )
      );

      const real = async (step: StepValue, model: Model) => {
        if (step === "take" || step === "release") {
          server.taken = step === "take";

          return;
        }

        if (step === "send") {
          const result = await call({
            action: "send",
            message: "hello",
            to: "peer",
          });

          expect(result.text).not.toContain("NotConfigured");
          expect(result.isError).toBe(false);

          return;
        }

        const before = server.acquires;
        const result = await call({ action: "claim" });
        const recovers = !model.live && !model.taken;

        expect(result.isError).toBe(!recovers);

        if (!model.live && model.taken) {
          expect(result.text).toContain("taker");
          expect(server.acquires).toBe(before);
        }

        if (recovers) {
          await Effect.runPromiseWith(context)(
            eventually(
              Effect.promise(async () => await call({ action: "status" })).pipe(
                Effect.filterOrFail(
                  (next) =>
                    server.acquires > before &&
                    !/held by another live Pi/u.test(next.text)
                )
              )
            )
          );
          expect(server.acquires).toBeGreaterThan(before);
        }
      };

      yield* Effect.promise(async () => {
        await fc.asyncModelRun(
          () => {
            const model: Model = { live: false, taken: true };

            return {
              model,
              real: async (step: StepValue) => {
                await real(step, model);
              },
            };
          },
          steps.map((step) => new Command(step))
        );
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 }, timeout: 60_000 }
);

const Gate = Schema.Struct({
  contentRight: Schema.Boolean,
  early: Schema.Boolean,
  mode: Schema.Literals([0o600, 0o644, 0o400, 0o660]),
});

const GATE_BLOCKED_NSIDS = /acquireLease|ack/u;

it.live.prop(
  "a restart gate holds the lease claim and every ack until the file is a 0600 regular file holding this session id",
  [Arbitrary.schema(Gate)],
  ([gate]) =>
    Effect.gen(function* gated() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const gatePath = `${state}/restart-gate.json`;
      const calls: string[] = [];
      const server: Server = { acquires: 0, taken: false };
      const served = lease(server);

      const http = HttpClient.make((request) =>
        Effect.suspend(() => {
          calls.push(new URL(request.url).pathname);

          return served.http.execute(request);
        })
      );

      const write = (right: boolean, mode: number) =>
        Effect.gen(function* put() {
          yield* fs.remove(gatePath, { force: true });
          yield* fs.writeFileString(
            gatePath,
            JSON.stringify(right ? "gated" : "someone-else"),
            { mode }
          );
          yield* fs.chmod(gatePath, mode);
        });

      const opens = gate.contentRight && gate.mode === 0o600;

      if (gate.early) {
        yield* write(gate.contentRight, gate.mode);
      }

      yield* Effect.gen(function* proof() {
        const ratking = yield* RatKing;

        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            pane: Option.none(),
            pid: 1,
            restartGate: gatePath,
            session: "gated",
          },
          () => Effect.void
        );

        const settled = gate.early && opens;

        yield* Effect.sleep("300 millis");

        if (settled) {
          yield* eventually(
            ratking.status.pipe(
              Effect.filterOrFail((status) =>
                ReaderState.$is("Live")(status.reader)
              )
            )
          );

          return;
        }

        expect(calls.filter((nsid) => GATE_BLOCKED_NSIDS.test(nsid))).toEqual(
          []
        );
        expect(server.acquires).toBe(0);
        expect(ReaderState.$is("Live")((yield* ratking.status).reader)).toBe(
          false
        );

        yield* write(true, 0o600);
        yield* eventually(
          ratking.status.pipe(
            Effect.filterOrFail((status) =>
              ReaderState.$is("Live")(status.reader)
            )
          )
        );
        expect(server.acquires).toBeGreaterThan(0);
      }).pipe(Effect.provide(harness(state, http)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 }, timeout: 60_000 }
);

it.effect.prop(
  "MUSTER_RESTART_GATE reaches the reader as its gate path, and only when set",
  [Arbitrary.schema(Schema.Option(Schema.String.check(Schema.isMinLength(1))))],
  ([path]) =>
    collectFacts("s", undefined, true, []).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: Option.isSome(path) ? { MUSTER_RESTART_GATE: path.value } : {},
          })
        )
      ),
      Effect.tap((facts) =>
        Effect.sync(() => {
          expect(facts.restartGate).toBe(Option.getOrUndefined(path));
        })
      )
    )
);
