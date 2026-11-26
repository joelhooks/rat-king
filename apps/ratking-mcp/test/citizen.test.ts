// @effect-diagnostics asyncFunction:off -- fast-check drives the citizen reader through a Promise boundary.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  Schedule,
  Schema,
  Scope,
} from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { harness } from "../../../packages/pi-ratking/test/harness.ts";
import {
  fakeMailbox,
  mail,
  people,
  seeded,
  socketLayer,
} from "../../ratking-cli/test/fixture.ts";
import { makeCitizen } from "../src/citizen.ts";
import { stdio } from "./stdio.ts";

const Steps = Schema.Array(
  Schema.Literals(["restart", "read", "ackNext", "ackOutOfOrder"])
).check(Schema.isMaxLength(5));

const Batch = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ id: Schema.String })),
});

type Citizen = Effect.Success<ReturnType<typeof makeCitizen>>;

type Step = (typeof Steps.Type)[number];

interface Model {
  read: number;
}

interface Real {
  readonly ids: readonly string[];
  readonly batch: () => Promise<readonly string[]>;
  readonly ack: (
    id: string
  ) => Promise<
    | Effect.Success<ReturnType<Citizen["ack"]>>
    | Effect.Error<ReturnType<Citizen["ack"]>>
  >;
  readonly restart: () => Promise<void>;
  readonly receipts: () => readonly string[];
}

const command = (step: Step): AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (model, real) => {
    const next = real.ids[model.read];
    const last = real.ids.at(-1);

    if (step === "restart") {
      await real.restart();
    }

    if (step === "ackNext" && next !== undefined) {
      expect(await real.ack(next)).toEqual({ acked: [next] });
      model.read += 1;
    }

    if (step === "ackOutOfOrder" && last !== undefined && last !== next) {
      expect(await real.ack(last)).toMatchObject({ code: "NotAttempted" });
    }

    expect(await real.batch()).toEqual(real.ids.slice(model.read));
    expect(real.receipts()).toEqual(
      real.ids.map((_, index) => (index < model.read ? "acked" : "delivered"))
    );
  },
  toString: () => step,
});

it.live.prop(
  "the name-scoped reader preserves exactly the unsettled suffix across restarts",
  [Steps],
  ([steps]) =>
    Effect.gen(function* proof() {
      const state = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const who = yield* people;

      const messages = yield* Effect.forEach([1, 2, 3], (seq) =>
        mail(seq === 2 ? { ...who, peer: who.other } : who, seq, "accepted", {
          body: `test-${seq}`,
          cc: [],
          thread: `thread-${seq}`,
        })
      );

      const fake = fakeMailbox(messages);

      const wiring = harness(state, fake.http, [], {
        secrets: seeded(who),
      }).pipe(Layer.provideMerge(socketLayer));

      const start = Effect.gen(function* startReader() {
        yield* Directory.use((directory) =>
          directory.record("peer", who.peerDocument)
        );
        yield* Directory.use((directory) =>
          directory.record("other", who.otherDocument)
        );
        const citizen = yield* makeCitizen("tester");
        yield* citizen.ready.pipe(
          Effect.retry({ schedule: Schedule.spaced("15 millis"), times: 150 })
        );

        return citizen;
      }).pipe(Effect.provide(wiring));

      const scope = yield* Effect.scope;
      let intake = yield* Scope.fork(scope);
      let citizen: Citizen = yield* Scope.provide(start, intake);
      const context = yield* Effect.context();
      // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check operates against Promise-returning commands.
      const run = Effect.runPromiseWith(context);
      const ids = messages.map(({ event }) => event.receipt.message.messageId);
      yield* Effect.promise(async () => {
        await asyncModelRun(
          () => ({
            model: { read: 0 },
            real: {
              // oxlint-disable-next-line typescript/promise-function-async -- The model already receives a Promise from the Effect runner.
              ack: (id: string) =>
                run(citizen.ack([id]).pipe(Effect.catch(Effect.succeed))),
              batch: async () => {
                const result = await run(
                  citizen.batch.pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Batch))
                  )
                );

                return result.messages.map(({ id }) => id);
              },
              ids,
              receipts: () => messages.map(({ state: receipt }) => receipt),
              restart: async () => {
                await run(Scope.close(intake, Exit.void));
                intake = await run(Scope.fork(scope));
                citizen = await run(Scope.provide(start, intake));
              },
            },
          }),
          ["read", "ackNext", "restart", ...steps].map((step) =>
            command(
              Schema.decodeUnknownSync(
                Schema.Literals(["restart", "read", "ackNext", "ackOutOfOrder"])
              )(step)
            )
          )
        );
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 45_000 }
);

it.live.prop(
  "reply-all uses the thread's CC and can seal the reply",
  [Schema.Boolean],
  ([encrypt]) =>
    Effect.gen(function* proof() {
      const state = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const who = yield* people;

      const incoming = yield* mail(who, 1, "accepted", {
        body: "test",
        cc: ["other"],
        thread: "root",
      });

      const fake = fakeMailbox([incoming]);
      yield* Effect.gen(function* reply() {
        yield* Directory.use((directory) =>
          directory.record("peer", who.peerDocument)
        );
        yield* Directory.use((directory) =>
          directory.record("other", who.otherDocument)
        );
        const client = yield* stdio("tester");
        expect(
          yield* client.call("reply", {
            encrypt,
            message: "test reply",
            replyTo: incoming.event.receipt.message.messageId,
            summary: "Test reply",
          })
        ).toMatchObject({ delivered: { to: "peer" } });
        expect(fake.sends.map(({ aad }) => aad.recipientDid)).toEqual([
          who.peer.did,
          who.other.did,
        ]);
        expect(fake.sends.map(({ enc }) => enc.length > 1)).toEqual([
          encrypt,
          encrypt,
        ]);
      }).pipe(
        Effect.provide(
          harness(state, fake.http, [], { secrets: seeded(who) }).pipe(
            Layer.provideMerge(socketLayer)
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 45_000 }
);
