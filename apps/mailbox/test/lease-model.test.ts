// @effect-diagnostics asyncFunction:off -- fast-check async commands drive the real Effect service with its captured TestClock.
import { it } from "@effect/vitest";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import type { HandlerInterface as MailboxInterface } from "@rat-king/lexicon/mailbox-handlers";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import type * as RuntimeLease from "@rat-king/lexicon/runtime.lease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import {
  Arbitrary,
  Clock,
  DateTime,
  Effect,
  Layer,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import * as fc from "fast-check";
import { expect } from "vitest";

import {
  sealed,
  recipientDid,
} from "../../../packages/envelope/test/helpers.ts";
import { staticResolver } from "../src/auth.ts";
import type { LeaseInterface } from "../src/lease.ts";
import {
  Caller,
  handlersLayer,
  LeaseAuthority,
  leaseLayer,
} from "../src/mailbox.ts";
import { SenderFence } from "../src/sender-fence.ts";
import { MailboxStore } from "../src/store.ts";
import type { Transaction } from "../src/store.ts";
import { TestFailure } from "./celld.ts";
import { documents, testStore } from "./helpers.ts";

interface Model {
  generation: number;
  holder?: RuntimeLease.MainValue | undefined;
  old: RuntimeLease.MainValue[];
  now: number;
}

interface Real {
  leases: LeaseInterface;
  handlers: MailboxInterface;
  message: Parameters<MailboxInterface["ack"]>[0]["message"];
  envelope: Parameters<MailboxInterface["send"]>[0]["envelope"];
  tx: <A>(operation: (tx: Transaction) => A) => Effect.Effect<A, XrpcFailure>;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

const iso = (now: number) => DateTime.formatIso(DateTime.makeUnsafe(now));

const acquireInput = (now: number, delta: number) =>
  Schema.decodeUnknownSync(Acquire.Input)({
    did: recipientDid,
    expiresAt: iso(now + delta),
    harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: "model" },
  });

const fenceInput = (lease: RuntimeLease.MainValue) =>
  Schema.decodeUnknownSync(Release.Input)({
    did: recipientDid,
    generation: lease.generation,
    leaseId: lease.leaseId,
  });

const refused = <A, E>(effect: Effect.Effect<A, E>, error: string) =>
  effect.pipe(
    Effect.result,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(
            Schema.is(Schema.Struct({ error: Schema.Literal(error) }))(
              result.failure
            )
          ).toBe(true);
        }
      })
    )
  );

type Kind = "acquire" | "renew" | "advance" | "release" | "stale";

const checkModel = async (model: Model, real: Real) => {
  const actual = await real.run(real.tx((tx) => tx.lease()));
  expect(actual?.generation ?? 0).toBe(model.generation);

  const current =
    model.holder && Date.parse(model.holder.expiresAt) > model.now
      ? model.holder
      : undefined;

  if (current) {
    expect(await real.run(real.leases.resolve(recipientDid))).toEqual(current);
    await real.run(
      refused(real.handlers.send({ envelope: real.envelope }), "LeaseMismatch")
    );

    const admitted = await real.run(
      real.handlers.send({
        envelope: real.envelope,
        generation: current.generation,
        leaseId: current.leaseId,
      })
    );

    const input = {
      generation: current.generation,
      leaseId: current.leaseId,
      message: admitted.receipt.message,
      recipientDid: real.envelope.aad.recipientDid,
    };

    const delivered = await real.run(real.handlers.deliver(input));
    expect(await real.run(real.handlers.deliver(input))).toEqual(delivered);
  } else {
    await real.run(refused(real.leases.resolve(recipientDid), "LeaseNotFound"));
    await real.run(real.handlers.send({ envelope: real.envelope }));
  }
};

class Command implements fc.AsyncCommand<Model, Real> {
  readonly kind: Kind;
  readonly delta: number;
  constructor(kind: Kind, delta: number) {
    this.kind = kind;
    this.delta = delta;
  }
  check(model: Readonly<Model>) {
    return this.kind !== "stale" || model.old.length > 0;
  }
  async run(model: Model, real: Real) {
    const live =
      model.holder !== undefined &&
      Date.parse(model.holder.expiresAt) > model.now;

    switch (this.kind) {
      case "acquire": {
        const input = acquireInput(model.now, this.delta);

        if (this.delta <= 0) {
          await real.run(refused(real.leases.acquire(input), "InvalidRequest"));
          break;
        }

        if (live) {
          await real.run(refused(real.leases.acquire(input), "LeaseHeld"));
          break;
        }

        if (model.holder) {
          model.old.push(model.holder);
        }

        const lease = await real.run(real.leases.acquire(input));
        model.generation += 1;
        expect(lease.generation).toBe(model.generation);
        expect(Date.parse(lease.expiresAt)).toBe(
          model.now + Math.min(this.delta, 300_000)
        );
        model.holder = lease;
        break;
      }

      case "renew": {
        if (!model.holder) {
          break;
        }

        const input = Schema.decodeUnknownSync(Renew.Input)({
          ...fenceInput(model.holder),
          expiresAt: iso(model.now + this.delta),
        });

        if (!live) {
          await real.run(refused(real.leases.renew(input), "LeaseMismatch"));
          break;
        }

        if (this.delta <= 0) {
          await real.run(refused(real.leases.renew(input), "InvalidRequest"));
          break;
        }

        const renewed = await real.run(real.leases.renew(input));
        expect(renewed.generation).toBe(model.generation);
        expect(Date.parse(renewed.expiresAt)).toBe(
          model.now + Math.min(this.delta, 300_000)
        );
        model.holder = renewed;
        break;
      }

      case "advance": {
        const next = Math.max(
          model.now + 1,
          Date.parse(model.holder?.expiresAt ?? iso(model.now)) + 1
        );

        await real.run(TestClock.setTime(next));
        model.now = next;

        if (model.holder) {
          model.old.push(model.holder);
        }

        break;
      }

      case "release": {
        if (!model.holder) {
          break;
        }

        if (!live) {
          await real.run(
            refused(
              real.leases.release(fenceInput(model.holder)),
              "LeaseMismatch"
            )
          );
          break;
        }

        await real.run(real.leases.release(fenceInput(model.holder)));
        model.old.push(model.holder);
        model.holder = undefined;
        break;
      }

      case "stale": {
        const [stale] = model.old;

        if (!stale) {
          throw new Error("Missing stale fence");
        }

        const fence = fenceInput(stale);

        const before = await real.run(
          real.tx((tx) => ({ lease: tx.lease(), seq: tx.watermark() }))
        );

        await real.run(
          refused(
            real.leases.renew(
              Schema.decodeUnknownSync(Renew.Input)({
                ...fence,
                expiresAt: iso(model.now + 1000),
              })
            ),
            "LeaseMismatch"
          )
        );
        await real.run(refused(real.leases.release(fence), "LeaseMismatch"));

        const input = {
          generation: stale.generation,
          leaseId: stale.leaseId,
          message: real.message,
          recipientDid: real.envelope.aad.recipientDid,
        };

        await real.run(refused(real.handlers.deliver(input), "LeaseMismatch"));
        await real.run(refused(real.handlers.ack(input), "LeaseMismatch"));
        await real.run(
          refused(
            real.handlers.send({
              envelope: real.envelope,
              generation: stale.generation,
              leaseId: stale.leaseId,
            }),
            "LeaseMismatch"
          )
        );
        expect(
          await real.run(
            real.tx((tx) => ({ lease: tx.lease(), seq: tx.watermark() }))
          )
        ).toEqual(before);
        break;
      }

      default: {
        const exhaustive: never = this.kind;

        throw new Error(String(exhaustive));
      }
    }

    await checkModel(model, real);
  }
  toString() {
    return `${this.kind}(${this.delta})`;
  }
}

const Delta = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(-1),
  Schema.isLessThanOrEqualTo(600_000)
);

const CommandSpec = Schema.Struct({
  delta: Delta,
  kind: Schema.Literals(["acquire", "renew", "advance", "release", "stale"]),
});

it.effect.prop(
  "exclusive monotonic lease model refuses every stale fence without state change",
  [Arbitrary.array(Arbitrary.schema(CommandSpec), { maxLength: 30 })],
  ([commands]) =>
    Effect.gen(function* modelProof() {
      const sample = yield* sealed();

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const storage = yield* testStore;

      const leases = yield* LeaseAuthority.pipe(
        Effect.provide(leaseLayer.pipe(Layer.provide(storage.layer)))
      );

      const handlers = yield* MailboxHandlers.pipe(
        Effect.provide(
          handlersLayer.pipe(
            Layer.provide(storage.layer),
            Layer.provide(staticResolver(docs)),
            Layer.provide(Layer.succeed(Caller, { did: recipientDid })),
            Layer.provide(
              Layer.succeed(SenderFence, {
                check: (_did, fence) => leases.checkSend(fence),
              })
            )
          )
        )
      );

      const store = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      const context = yield* Effect.context();

      const run: Real["run"] = async (effect) =>
        // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check AsyncCommand requires a Promise; the owning property uses it.effect and this captured TestClock.
        await Effect.runPromiseWith(context)(effect);

      const now = yield* Clock.currentTimeMillis;

      const envelope = {
        ...sample.envelope,
        aad: {
          ...sample.envelope.aad,
          senderDid: sample.envelope.aad.recipientDid,
        },
      };

      const { message } = (yield* handlers.send({ envelope })).receipt;
      const model: Model = { generation: 0, now, old: [] };

      const real: Real = {
        envelope,
        handlers,
        leases,
        message,
        run,
        tx: store.transaction,
      };

      const required: Command[] = [
        new Command("acquire", 600_000),
        new Command("acquire", 1000),
        new Command("renew", 400_000),
        new Command("release", 0),
        new Command("acquire", 1000),
        new Command("stale", 0),
        new Command("advance", 0),
        new Command("stale", 0),
        new Command("acquire", 1000),
      ];

      yield* Effect.tryPromise({
        catch: (cause) => new TestFailure({ message: String(cause) }),
        try: async () => {
          await fc.asyncModelRun(
            () => ({ model, real }),
            [
              ...required,
              ...commands.map(({ kind, delta }) => new Command(kind, delta)),
            ]
          );
        },
      });
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 40 }, timeout: 30_000 }
);

it.effect("legacy lease row expands without resetting generation", () =>
  Effect.gen(function* expand() {
    const storage = yield* testStore;
    storage.sql.exec(
      "INSERT INTO lease(singleton,value) VALUES(1,?)",
      JSON.stringify({ expiresAt: 0, generation: 41, leaseId: "3m7x2ka4xv22b" })
    );

    const leases = yield* LeaseAuthority.pipe(
      Effect.provide(leaseLayer.pipe(Layer.provide(storage.layer)))
    );

    const lease = yield* leases.acquire(
      acquireInput(yield* Clock.currentTimeMillis, 1000)
    );

    expect(lease.generation).toBe(42);
    expect(lease.did).toBe(recipientDid);
  }).pipe(Effect.scoped)
);
