// @effect-diagnostics asyncFunction:off -- Pi's extension API is the Promise boundary under test.
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { AgentName } from "@rat-king/ratking-client/name";
import {
  Arbitrary,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import {
  ratkingExtension,
  STATUS_EVENT,
  STATUS_RESULT_EVENT,
} from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import { RETIRE_COMMAND, retiredLine } from "../src/retire.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

const OWN = "rats-nest/nameless";

const OTHER = "rats-nest/other";

const REFUSED = /^ratking retire refused: .+ \| .+ \| .+$/u;

const RetireInput = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    successor: Schema.optionalKey(Schema.String),
  })
);

type Handler = (args: string, print: (line: string) => void) => Promise<void>;

const idle = async () => {};

interface Mailbox {
  readonly retires: (typeof RetireInput.Type)[];
  readonly http: HttpClient.HttpClient;
}

const mailbox = (reachable: boolean): Mailbox => {
  const retires: (typeof RetireInput.Type)[] = [];

  const http = HttpClient.make((request) =>
    Effect.gen(function* fakeMailbox() {
      const isRetire = request.url.endsWith(
        "sh.mschf.ratking.identity.retireName"
      );

      if (!(isRetire && Predicate.isTagged(request.body, "Uint8Array"))) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "MailboxUnavailable" }, { status: 503 })
        );
      }

      const input = yield* Schema.decodeUnknownEffect(RetireInput)(
        new TextDecoder().decode(request.body.body)
      ).pipe(Effect.orDie);

      retires.push(input);

      return HttpClientResponse.fromWeb(
        request,
        reachable
          ? Response.json({
              ...input,
              by: "did:web:rats-nest.nameless.agents.example.invalid",
              did: "did:web:rats-nest.nameless.agents.example.invalid",
              retiredAt: "2026-10-19T00:00:00.000Z",
            })
          : Response.json({ error: "MailboxUnavailable" }, { status: 503 })
      );
    })
  );

  return { http, retires };
};

const boot = (
  state: string,
  box: Mailbox,
  known: readonly string[],
  started: boolean
) =>
  Effect.gen(function* bootExtension() {
    const commands = new Map<string, Handler>();
    let start: (start: SessionStart) => Promise<void> = idle;
    let end: () => Promise<void> = idle;

    const pi: PiHost = {
      events: createEventBus(),
      onSessionEnd: (handler) => {
        end = handler;
      },
      onSessionStart: (handler) => {
        start = handler;
      },
      registerCommand: (name, command) => {
        commands.set(name, command.handler);
      },
      registerMessageRenderer: () => {},
      registerTool: () => {},
      sendMessage: () => {},
    };

    const peer = yield* document(
      yield* identity("did:web:successor.agents.example.invalid")
    );

    const layer = Layer.effectDiscard(
      Directory.use((directory) =>
        Effect.gen(function* recordKnown() {
          for (const name of known) {
            yield* directory.record(name, peer).pipe(Effect.orDie);
          }
        })
      )
    ).pipe(Layer.provideMerge(harness(state, box.http)));

    yield* Effect.promise(async () => {
      await ratkingExtension({
        facts: (session) =>
          Effect.succeed({
            alive: () => false,
            env: Option.some(OWN),
            pane: Option.none(),
            pid: 1,
            session,
          }),
        layer,
        tool: Effect.succeed("ratking"),
      })(pi);
    });

    if (started) {
      yield* Effect.promise(async () => {
        await startSession(start, { session: "test-session", warn: () => {} });
      });
    }

    const retire = (args: string) =>
      Effect.promise(async () => {
        const lines: string[] = [];

        await commands.get(RETIRE_COMMAND)?.(args, (line) => {
          lines.push(line);
        });

        return lines;
      });

    const reader = Effect.gen(function* readerStatus() {
      const answered = yield* Deferred.make<unknown>();

      pi.events.on(STATUS_RESULT_EVENT, (data) => {
        Deferred.doneUnsafe(answered, Effect.succeed(data));
      });
      pi.events.emit(STATUS_EVENT, { requestId: "status" });

      return yield* Deferred.await(answered).pipe(Effect.timeout("5 seconds"));
    });

    const stop = Effect.promise(async () => {
      await end();
    });

    return { commands, reader, retire, stop };
  });

const Successor = AgentName.check(
  Schema.makeFilter((name: string) => name !== OWN && name !== OTHER)
);

it.live.prop(
  "/ratking-retire <successor> prints exactly the retired line, retires once, stops the reader, and repeats the line without a second mailbox call; a different successor is refused",
  [Arbitrary.schema(Successor)],
  ([successor]) =>
    Effect.gen(function* retireOnce() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const box = mailbox(true);
      const pi = yield* boot(state, box, [successor, OTHER], true);

      expect([...pi.commands.keys()]).toContain(RETIRE_COMMAND);

      expect(yield* pi.retire(` ${successor} `)).toEqual([
        retiredLine(OWN, successor),
      ]);
      expect(box.retires).toEqual([{ name: OWN, successor }]);
      expect(yield* pi.reader).toMatchObject({ reader: "retired" });

      expect(yield* pi.retire(successor)).toEqual([
        retiredLine(OWN, successor),
      ]);

      const different = yield* pi.retire(OTHER);

      expect(different).toHaveLength(1);
      expect(different[0]).toMatch(REFUSED);
      expect(different[0]).toContain(`already retired to ${successor}`);
      expect(box.retires).toHaveLength(1);

      yield* pi.stop;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 }, timeout: 60_000 }
);

const Refusal = Schema.Literals([
  "missing",
  "invalid",
  "unknown",
  "unreachable",
  "no-name",
]);

const refusalCase = {
  invalid: { args: "Not A Name!", what: "is not a Rat King name" },
  missing: { args: "   ", what: "successor missing" },
  "no-name": { args: OTHER, what: "this Pi has no Rat King name" },
  unknown: { args: "rats-nest/ghost", what: "is unknown" },
  unreachable: { args: OTHER, what: "mailbox unreachable" },
} as const;

it.live.prop(
  "every /ratking-retire refusal prints one what | why | next line naming its case, and the reader keeps its name",
  [Arbitrary.schema(Refusal)],
  ([refusal]) =>
    Effect.gen(function* refuse() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const box = mailbox(refusal !== "unreachable");
      const pi = yield* boot(state, box, [OTHER], refusal !== "no-name");
      const lines = yield* pi.retire(refusalCase[refusal].args);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(REFUSED);
      expect(lines[0]).toContain(refusalCase[refusal].what);
      expect(box.retires).toHaveLength(refusal === "unreachable" ? 1 : 0);
      expect(yield* pi.reader).not.toMatchObject({ reader: "retired" });

      yield* pi.stop;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 }, timeout: 60_000 }
);
