/* oxlint-disable typescript/promise-function-async -- The fake cell returns the Effect runtime Promise directly. */
import { it } from "@effect/vitest";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import type * as RuntimeLease from "@rat-king/lexicon/runtime.lease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import { Effect, Layer, Match, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  ackNameState,
  applyNameTicket,
  pendingNameState,
  standingState,
} from "../src/cell-name-state.ts";
import { IssuerStore, issuerStore } from "../src/issuer-store.ts";
import { LeaseAuthority, leaseLayer } from "../src/lease.ts";
import {
  NameCommand,
  NameState,
  observedStatus,
  Ticket,
  TicketOutcome,
  TicketReply,
} from "../src/name-state.ts";
import type { NameStateValue, TicketValue } from "../src/name-state.ts";
import { drainTickets, runNameTicket } from "../src/name-tickets.ts";
import { isoTime } from "../src/retirement.ts";
import { sqliteStore } from "../src/sqlite.ts";
import { MailboxStore } from "../src/store.ts";
import { testStoreFor } from "./helpers.ts";
import { runModel } from "./record-retired-model.ts";

const did = "did:web:reader.example.invalid";

const name = "reader";

const retirement = { by: did, name, retiredAt: 1000 };

const acquireInput = {
  did,
  expiresAt: "1970-01-01T00:00:03.000Z",
  harness: {
    $type: "sh.mschf.ratking.runtime.lease#pi",
    sessionId: "projection",
  },
} as const;

const Commands = Schema.Array(
  Schema.Struct({
    kind: Schema.Literals([
      "acquire",
      "resume",
      "renew",
      "release",
      "retire",
      "repoint",
      "unretire",
    ]),
    wire: Schema.Literals(["drop", "deliver", "duplicate", "previous"]),
  })
).check(Schema.isMaxLength(36));

const fixture = Effect.gen(function* fixture() {
  const cell = yield* testStoreFor(did);
  const index = yield* testStoreFor("did:web:issuer.example.invalid");
  const layer = issuerStore(index.sql);
  const issuer = yield* IssuerStore.pipe(Effect.provide(layer));
  const store = yield* MailboxStore.pipe(Effect.provide(cell.layer));

  const leases = yield* LeaseAuthority.pipe(
    Effect.provide(leaseLayer.pipe(Layer.provide(cell.layer)))
  );

  const current = store.transaction((tx) => standingState(cell.sql, tx));

  const apply = (ticket: TicketValue) =>
    store.standingTransaction(1000, (tx, stage) =>
      applyNameTicket(cell.sql, tx, ticket, [{ id: did }], 1000, stage)
    );

  return { apply, cell, current, index, issuer, layer, leases };
});

interface Model {
  lease?: RuntimeLease.MainValue | undefined;
  version: number;
  latest?: NameStateValue | undefined;
  delivered?: NameStateValue;
  retired: boolean;
}

type Real =
  typeof fixture extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

type Command = (typeof Commands.Type)[number];

const retireCommand = NameCommand.cases.Retire.make({
  holderMayRetire: true,
  retirement,
});

const clearCommand = NameCommand.cases.Clear.make({ name });

const repointCommand = (successor: string) =>
  NameCommand.cases.Repoint.make({ successor, updatedAt: 1000 });

const deliver = Effect.fn("Projection.deliverTestPush")(function* deliver(
  wire: Command["wire"],
  model: Model,
  real: Real,
  next: NameStateValue
) {
  const sent = wire === "previous" ? model.latest : next;
  model.latest = next;

  if (wire !== "drop" && sent !== undefined) {
    const ack = yield* real.issuer.transaction((tx) => tx.observe(sent));

    if (wire === "duplicate") {
      yield* real.issuer.transaction((tx) => tx.observe(sent));
    }

    ackNameState(real.cell.sql, ack);

    if (ack < model.version) {
      expect(pendingNameState(real.cell.sql)).toEqual(next);
    }

    if (sent.version > (model.delivered?.version ?? 0)) {
      model.delivered = sent;
    }
  }

  const observed = yield* real.issuer.transaction((tx) => tx.observation(did));
  expect(observed).toEqual(model.delivered);

  if (observed !== undefined) {
    expect(observedStatus(observed, observed.leaseExpiresAt)).not.toBe("live");
  }
});

const modelStep = ({ kind, wire }: Command) => ({
  check: (model: Readonly<Model>) => {
    if (kind === "repoint") {
      return model.retired;
    }

    return (
      !["renew", "release", "resume"].includes(kind) ||
      model.lease !== undefined
    );
  },
  run: (model: Model, real: Real) =>
    Effect.gen(function* step() {
      const { apply, cell, current, leases } = real;

      const fence =
        model.lease === undefined
          ? { did }
          : {
              did,
              generation: model.lease.generation,
              leaseId: model.lease.leaseId,
            };

      switch (kind) {
        case "acquire": {
          if (model.lease !== undefined) {
            yield* leases.release(
              yield* Schema.decodeUnknownEffect(Release.Input)(fence)
            );
            model.version += 1;
          }

          model.lease = yield* leases.acquire(
            yield* Schema.decodeEffect(Acquire.Input)({
              ...acquireInput,
              expiresAt: isoTime(3000),
            })
          );
          model.retired = false;
          break;
        }

        case "resume": {
          model.lease = yield* leases.acquire(
            yield* Schema.decodeEffect(Acquire.Input)({
              ...acquireInput,
              ...fence,
              expiresAt: isoTime(4000),
            })
          );
          break;
        }

        case "renew": {
          model.lease = yield* leases.renew(
            yield* Schema.decodeUnknownEffect(Renew.Input)({
              ...fence,
              expiresAt: isoTime(5000),
            })
          );
          break;
        }

        case "release": {
          yield* leases.release(
            yield* Schema.decodeUnknownEffect(Release.Input)(fence)
          );
          model.lease = undefined;
          break;
        }

        case "retire":
        case "repoint":
        case "unretire": {
          const command = Match.value(kind).pipe(
            Match.when("retire", () => retireCommand),
            Match.when("repoint", () =>
              repointCommand(`next-${model.version}`)
            ),
            Match.when("unretire", () => clearCommand),
            Match.exhaustive
          );

          const reply = yield* apply({
            command,
            did,
            expectedVersion: model.version,
            opId: `op-${model.version}`,
          });

          expect(reply.outcome._tag).toBe("Applied");
          model.retired = kind !== "unretire";
          break;
        }

        default: {
          const impossible: never = kind;

          return yield* Effect.die(impossible);
        }
      }

      model.version += 1;
      const next = pendingNameState(cell.sql);
      expect(next?.version).toBe(model.version);
      expect(next?.retirement !== null).toBe(model.retired);
      expect(next).toEqual(yield* current);

      if (model.lease !== undefined) {
        expect(next?.leaseExpiresAt).toBe(Date.parse(model.lease.expiresAt));
        expect(next?.leaseGeneration).toBe(model.lease.generation);
      }

      if (next === undefined) {
        return yield* Effect.die("Broken test state: outbox missing");
      }

      yield* deliver(wire, model, real, next);

      return yield* Effect.void;
    }),
  toString: () => `${kind}/${wire}`,
});

it.effect.prop(
  "standing converges through coalescing, dropped, reordered and duplicated pushes",
  { commands: Commands },
  ({ commands }) =>
    Effect.gen(function* test() {
      yield* TestClock.setTime(1000);
      const real = yield* fixture;
      yield* runModel(
        () => ({ model: { retired: false, version: 0 }, real }),
        commands.map(modelStep)
      );
      const pending = pendingNameState(real.cell.sql);

      if (pending !== undefined) {
        ackNameState(
          real.cell.sql,
          yield* real.issuer.transaction((tx) => tx.observe(pending))
        );
      }

      expect(pendingNameState(real.cell.sql)).toBeUndefined();

      if (commands.length > 0 && (yield* real.current).version > 0) {
        expect(
          yield* real.issuer.transaction((tx) => tx.observation(did))
        ).toEqual(yield* real.current);
      }
    }).pipe(Effect.scoped)
);

const StateJson = Schema.fromJsonString(NameState);

const TicketJson = Schema.fromJsonString(Ticket);

const ReplyJson = Schema.fromJsonString(TicketReply);

it.effect.prop(
  "lost durable ticket answers re-drive from the singleton and a newer acquire supersedes stale tickets",
  {
    kind: Schema.Literals(["Clear", "Repoint", "Retire"]),
    newerAcquire: Schema.Boolean,
  },
  ({ kind, newerAcquire }) =>
    Effect.gen(function* lostAnswer() {
      yield* TestClock.setTime(1000);
      const real = yield* fixture;

      if (kind !== "Retire") {
        yield* real.apply({
          command: retireCommand,
          did,
          expectedVersion: 0,
          opId: "initial",
        });
      }

      const command = Match.value(kind).pipe(
        Match.when("Retire", () => retireCommand),
        Match.when("Repoint", () => repointCommand("next")),
        Match.when("Clear", () => clearCommand),
        Match.exhaustive
      );

      let calls = 0;
      const context = yield* Effect.context();
      // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- The cell RPC adapter returns a Promise to the production driver.
      const run = Effect.runPromiseWith(context);

      const cells = {
        getByName: () => ({
          applyStandingTicket: (json: string) =>
            run(
              Schema.decodeEffect(TicketJson)(json).pipe(
                Effect.flatMap(real.apply),
                Effect.flatMap((reply) => {
                  calls += 1;

                  return calls === 1
                    ? Effect.die("answer lost after SQLite commit")
                    : Schema.encodeEffect(ReplyJson)(reply);
                })
              )
            ),
          standing: () => Promise.resolve({ exists: true }),
          standingRevision: () =>
            run(
              real.current.pipe(Effect.flatMap(Schema.encodeEffect(StateJson)))
            ),
        }),
      };

      const initial = yield* runNameTicket(cells, did, command).pipe(
        Effect.provide(real.layer),
        Effect.result
      );

      expect(Result.isFailure(initial)).toBe(true);
      expect(calls).toBe(1);

      if (newerAcquire) {
        yield* real.leases.acquire(
          yield* Schema.decodeEffect(Acquire.Input)(acquireInput)
        );
      }

      const cell = yield* real.current;
      expect(
        yield* real.issuer.transaction((tx) => tx.observation(did))
      ).toBeUndefined();
      yield* TestClock.setTime(6000);

      const answers = yield* drainTickets(cells).pipe(
        Effect.provide(real.layer)
      );

      expect(
        answers.map((answer) =>
          Result.isSuccess(answer) ? answer.success.outcome._tag : "failed"
        )
      ).toEqual([newerAcquire ? "Superseded" : "Applied"]);
      expect(yield* real.current).toEqual(cell);
      expect(
        yield* real.issuer.transaction((tx) => tx.observation(did))
      ).toEqual(cell);
      expect([...real.index.sql.exec("SELECT op_id FROM pending_ops")]).toEqual(
        []
      );
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "a lost source or successor answer leaves guarded retire due; compensation survives loss and never overwrites a newer revision",
  {
    firstLoss: Schema.Literals(["source", "successor"]),
    previouslyRetired: Schema.Boolean,
    race: Schema.Boolean,
    successor: Schema.Literals(["missing", "retired", "valid"]),
    undoLoss: Schema.Boolean,
  },
  ({ firstLoss, previouslyRetired, undoLoss, race, successor }) =>
    Effect.gen(function* retryGuardedRetirement() {
      yield* TestClock.setTime(1000);
      const real = yield* fixture;

      const previous = previouslyRetired
        ? { ...retirement, successor: "previous" }
        : null;

      if (previous !== null) {
        yield* real.apply({
          command: NameCommand.cases.Retire.make({
            holderMayRetire: true,
            retirement: previous,
          }),
          did,
          expectedVersion: 0,
          opId: "previous",
        });
      }

      const before = yield* real.current;
      const nextDid = "did:web:next.example.invalid";
      const guardedRetirement = { ...retirement, successor: "next" };
      let initial = true;
      let observedSuccessor = "valid";
      let checks = 0;
      let sourceCalls = 0;
      let undoCalls = 0;
      const context = yield* Effect.context();
      // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- Exercise the driver's real Promise RPC boundary.
      const run = Effect.runPromiseWith(context);

      const sendToSource = Effect.fn("Projection.sendToSource")(
        function* sendToSource(ticket: TicketValue) {
          const undo = ticket.opId.endsWith("/compensate");

          if (undo) {
            undoCalls += 1;

            if (race && undoCalls === 1) {
              yield* real.apply({
                command: repointCommand("newer"),
                did,
                expectedVersion: ticket.expectedVersion,
                opId: "newer",
              });
            }
          } else {
            sourceCalls += 1;
          }

          const reply = yield* real.apply(ticket);

          if (
            (!undo && initial && firstLoss === "source") ||
            (undo && undoCalls === 1 && undoLoss)
          ) {
            return yield* Effect.die("answer lost after SQLite commit");
          }

          return yield* Schema.encodeEffect(ReplyJson)(reply);
        }
      );

      const cells = {
        getByName: (target: string) => ({
          applyStandingTicket: (json: string) => {
            expect(target).toBe(did);

            return run(
              Schema.decodeEffect(TicketJson)(json).pipe(
                Effect.flatMap(sendToSource)
              )
            );
          },
          standing: () => {
            expect(target).toBe(nextDid);
            checks += 1;

            if (initial) {
              return Promise.reject(new Error("successor reply lost"));
            }

            return Promise.resolve({
              exists: observedSuccessor !== "missing",
              retirement: observedSuccessor === "retired" ? "{}" : undefined,
            });
          },
          standingRevision: () =>
            Promise.reject(new Error("unexpected revision read")),
        }),
      };

      const pending = () => [
        ...real.index.sql.exec("SELECT op_id FROM pending_ops"),
      ];

      const attempt = yield* runNameTicket(
        cells,
        did,
        NameCommand.cases.Retire.make({
          holderMayRetire: true,
          retirement: guardedRetirement,
        }),
        before.version,
        {
          did: nextDid,
          expected: "registered-unretired",
          name: "next",
          previous,
        }
      ).pipe(Effect.provide(real.layer), Effect.flip);

      expect(attempt.status).toBe(503);
      expect(pending()).toHaveLength(1);
      expect((yield* real.current).retirement).toEqual(guardedRetirement);
      expect(checks).toBe(firstLoss === "source" ? 0 : 1);
      initial = false;
      observedSuccessor = successor;
      yield* TestClock.setTime(6000);

      const drain = drainTickets(cells).pipe(Effect.provide(real.layer));
      const [first] = yield* drain;
      const invalid = successor !== "valid";
      const remainsDue = invalid && undoLoss;
      const expectedChecks = firstLoss === "source" ? 1 : 2;
      expect(checks).toBe(expectedChecks);
      expect(sourceCalls).toBe(2);

      if (remainsDue) {
        expect(first?._tag).toBe("Failure");
        expect(pending()).toHaveLength(1);
        observedSuccessor = "valid";
        yield* TestClock.setTime(12_000);
      }

      const answer = remainsDue ? (yield* drain)[0] : first;
      expect(answer?._tag).toBe("Success");
      expect(checks).toBe(expectedChecks);
      const expectedUndoCalls = undoLoss ? 2 : 1;
      expect(undoCalls).toBe(invalid ? expectedUndoCalls : 0);
      expect(pending()).toEqual([]);
      const current = yield* real.current;

      const compensated = race
        ? { ...guardedRetirement, successor: "newer", updatedAt: 1000 }
        : previous;

      expect(current.retirement).toEqual(
        invalid ? compensated : guardedRetirement
      );
      expect(
        yield* real.issuer.transaction((tx) => tx.observation(did))
      ).toEqual(current);

      if (answer !== undefined && Result.isSuccess(answer)) {
        expect(answer.success.outcome._tag).toBe(
          invalid ? "Refused" : "Applied"
        );

        if (TicketOutcome.guards.Refused(answer.success.outcome)) {
          expect(answer.success.outcome.message).toContain(
            successor === "missing" ? "no longer registered" : "now retired"
          );
          expect(answer.success.outcome.message).toContain(
            race ? "was not restored" : "standing restored"
          );
        }
      }
    }).pipe(Effect.scoped)
);

it.effect(
  "a durable acquire-clear with a lost answer retains the outbox for the next wake",
  () =>
    Effect.gen(function* ambiguousAcquire() {
      yield* TestClock.setTime(1000);
      const real = yield* fixture;
      yield* real.apply({
        command: retireCommand,
        did,
        expectedVersion: 0,
        opId: "retire",
      });
      const saved = yield* real.current;
      yield* real.issuer.transaction((tx) => tx.observe(saved));

      const cut = sqliteStore(
        real.cell.sql,
        did,
        undefined,
        Effect.void,
        false,
        {
          transaction: (operation) => {
            real.cell.sql.transaction(operation);

            return Promise.reject(
              new Error("Wake-entry answer lost after durable commit")
            );
          },
        }
      );

      const input = yield* Schema.decodeEffect(Acquire.Input)(acquireInput);

      const result = yield* LeaseAuthority.use((leases) =>
        leases.acquire(input)
      ).pipe(
        Effect.provide(leaseLayer.pipe(Layer.provide(cut))),
        Effect.result
      );

      expect(Result.isFailure(result)).toBe(true);
      expect(
        (yield* real.issuer.transaction((tx) => tx.observation(did)))
          ?.retirement
      ).toEqual(retirement);
      const retry = pendingNameState(real.cell.sql);
      expect(retry?.retirement).toBeNull();

      if (retry === undefined) {
        return yield* Effect.die("Outbox missing after the ambiguous cut");
      }

      ackNameState(
        real.cell.sql,
        yield* real.issuer.transaction((tx) => tx.observe(retry))
      );
      expect(
        yield* real.issuer.transaction((tx) => tx.observation(did))
      ).toEqual(yield* real.current);

      return yield* Effect.void;
    }).pipe(Effect.scoped)
);
