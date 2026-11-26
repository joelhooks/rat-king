// @effect-diagnostics asyncFunction:off -- fast-check drives the citizen reader through a Promise boundary.
// @effect-diagnostics nodeBuiltinImport:off -- Test the public fingerprint against Node's SHA-256.
import { createHash } from "node:crypto";

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
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { harness } from "../../../packages/pi-ratking/test/harness.ts";
import {
  fakeMailbox,
  mail,
  mailboxSocket,
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
  messages: Schema.Array(
    Schema.Struct({ id: Schema.String, verified: Schema.Boolean })
  ),
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

const waitReady = (citizen: Citizen) =>
  citizen.ready.pipe(
    Effect.retry({ schedule: Schedule.spaced("15 millis"), times: 150 })
  );

const fingerprint = (ids: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(ids)).digest("hex");

it.live.prop(
  "a visible direct arrival changes the wake fingerprint behind an unacked head; CC and quiet do not",
  [Schema.Boolean],
  ([ccFirst]) =>
    Effect.gen(function* proof() {
      const state = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const who = yield* people;

      const quiet = { quiet: true, to: "tester" } as const;
      const copy = { cc: ["tester"], to: "other" } as const;
      const silent = ccFirst ? [copy, quiet] : [quiet, copy];

      const direct = (seq: number) =>
        mail(who, seq, "accepted", { body: "test" });

      const head = yield* direct(1);
      const fresh = yield* direct(4);

      const skipped = yield* Effect.all(
        silent.map((payload, index) =>
          mail(who, index + 2, "accepted", { body: "test", ...payload })
        )
      );

      const padding = yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          mail(who, index + 5, "accepted", { body: "test", ...quiet })
        )
      );

      const beyondWindow = yield* direct(17);

      const pending: (typeof head)[] = [];
      const fake = fakeMailbox(pending);
      const socket = mailboxSocket();

      yield* Effect.gen(function* reader() {
        yield* Directory.use((directory) =>
          directory.record("peer", who.peerDocument)
        );
        const citizen = yield* makeCitizen("tester");
        yield* waitReady(citizen);
        expect(yield* citizen.wake).toMatchObject({ wakeFingerprint: null });

        const headId = head.event.receipt.message.messageId;
        const freshId = fresh.event.receipt.message.messageId;

        for (const item of [
          head,
          ...skipped,
          fresh,
          ...padding,
          beyondWindow,
        ]) {
          pending.push(item);
          yield* Effect.sync(socket.notify);
          yield* Effect.suspend(() =>
            item.state === "delivered"
              ? Effect.void
              : Effect.fail("mail not delivered")
          ).pipe(
            Effect.retry({ schedule: Schedule.spaced("15 millis"), times: 150 })
          );

          yield* citizen.batch.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Batch)),
            Effect.flatMap(({ messages: visible }) =>
              visible.length === Math.min(16, pending.length)
                ? Effect.void
                : Effect.fail("inbox has not caught up")
            ),
            Effect.retry({ schedule: Schedule.spaced("15 millis"), times: 150 })
          );
          expect(yield* citizen.wake).toMatchObject({
            batch: createHash("sha256").update(headId).digest("hex"),
            wakeFingerprint: fingerprint(
              item.event.seq < 4 ? [headId] : [headId, freshId]
            ),
          });
        }
      }).pipe(
        Effect.provide(
          harness(state, fake.http, [], { secrets: seeded(who) }).pipe(
            Layer.provideMerge(socket.layer)
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 45_000 }
);

it.effect(
  "reconciles a stalled subscription after mailbox downtime under the original live lease",
  () =>
    Effect.gen(function* proof() {
      const state = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const who = yield* people;
      const fresh = yield* mail(who, 1, "accepted", { body: "after restart" });
      const pending: (typeof fresh)[] = [];
      const fake = fakeMailbox(pending);

      let announced = false;

      const socket = mailboxSocket(() => {
        if (announced) {
          return false;
        }

        announced = true;

        return true;
      });

      let online = true;
      let failedLists = 0;

      const http = HttpClient.make((request) =>
        Effect.suspend(() => {
          if (online) {
            return fake.http.execute(request);
          }

          if (new URL(request.url).pathname.endsWith(".list")) {
            failedLists += 1;
          }

          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "MailboxUnavailable" }, { status: 503 })
            )
          );
        })
      );

      yield* Effect.gen(function* reader() {
        yield* Directory.use((directory) =>
          directory.record("peer", who.peerDocument)
        );
        const citizen = yield* makeCitizen("tester");
        yield* TestClock.withLive(waitReady(citizen));
        const before = fake.lease();
        expect(before).toBeDefined();

        online = false;
        yield* Effect.sync(socket.notify);
        yield* TestClock.adjust("155 seconds");
        expect(failedLists).toBeGreaterThan(0);
        expect(yield* citizen.ready.pipe(Effect.flip)).toMatchObject({
          code: "NotAttempted",
        });

        online = true;
        pending.push(fresh);
        yield* Effect.forEach(
          Array.from({ length: 12 }),
          () =>
            TestClock.adjust("5 seconds").pipe(
              Effect.andThen(TestClock.withLive(Effect.sleep("15 millis")))
            ),
          { discard: true }
        );
        yield* citizen.ready;
        expect(yield* citizen.batch).toMatchObject({
          messages: [
            { id: fresh.event.receipt.message.messageId, verified: true },
          ],
        });
        expect(fake.lease()).toMatchObject({
          generation: before?.generation,
          leaseId: before?.leaseId,
        });
        expect(fake.lease()?.expiresAt).not.toBe(before?.expiresAt);
        expect(
          fake.calls.filter(({ nsid }) => nsid.endsWith(".acquireLease"))
        ).toHaveLength(1);
      }).pipe(
        Effect.provide(
          harness(state, http, [], { secrets: seeded(who) }).pipe(
            Layer.provideMerge(socket.layer)
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
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
