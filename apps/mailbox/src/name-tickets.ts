/* oxlint-disable typescript/promise-function-async -- Lazy Durable Object RPC adapters. */
import { Clock, Effect, Schema } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { failure } from "./failure.ts";
import { IssuerStore } from "./issuer-store.ts";
import {
  NameCommand,
  NameState,
  Ticket,
  TicketOutcome,
  TicketReply,
} from "./name-state.ts";
import type {
  NameCommandValue,
  SuccessorCheckValue,
  TicketReplyValue,
  TicketValue,
} from "./name-state.ts";

export interface TicketCells {
  readonly getByName: (did: string) => {
    readonly applyStandingTicket: (json: string) => Promise<string>;
    readonly standingRevision: () => Promise<string>;
    readonly standing: () => Promise<{
      readonly exists: boolean;
      readonly retirement?: string | undefined;
    }>;
  };
}

export const mailboxCall = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => failure("MailboxUnavailable", 503),
    try: call,
  });

const applyTicket = Effect.fn("Issuer.applyTicket")(function* applyTicket(
  cells: TicketCells,
  ticket: TicketValue
) {
  const json = yield* mailboxCall(() =>
    cells
      .getByName(ticket.did)
      .applyStandingTicket(
        Schema.encodeSync(Schema.fromJsonString(Ticket))(ticket)
      )
  );

  const reply = yield* Schema.decodeEffect(Schema.fromJsonString(TicketReply))(
    json
  ).pipe(Effect.mapError(() => failure("MailboxUnavailable", 503)));

  if (reply.state.did !== ticket.did) {
    return yield* failure("MailboxUnavailable", 503);
  }

  return reply;
});

const overtaken = () =>
  failure(
    "MailboxUnavailable",
    503,
    "Standing changed while this operation was in flight; retry against the current revision"
  );

const settleTicket = Effect.fn("Issuer.settleTicket")(function* settleTicket(
  ticket: TicketValue,
  command: NameCommandValue,
  reply: TicketReplyValue
) {
  const store = yield* IssuerStore;

  return yield* store.transaction((tx) => {
    if (!tx.finishTicket(ticket)) {
      throw overtaken();
    }

    const before = tx.observation(ticket.did);
    tx.observe(reply.state);
    const current = tx.observation(ticket.did);

    if (current === undefined || current.version > reply.state.version) {
      return {
        outcome: TicketOutcome.cases.Superseded.make({}),
        state: current ?? reply.state,
      };
    }

    if (!TicketOutcome.guards.Refused(reply.outcome)) {
      if (current.retirement !== null) {
        tx.retire({ ...current.retirement, did: current.did });
      } else if (
        TicketOutcome.guards.Applied(reply.outcome) &&
        NameCommand.guards.Clear(command)
      ) {
        tx.unretire(command.name);
      } else if (
        before?.retirement !== null &&
        before?.retirement !== undefined
      ) {
        tx.unretire(before.retirement.name, before.retirement.retiredAt);
      }
    }

    return reply;
  });
});

const compensateTicket = Effect.fn("Issuer.compensateTicket")(
  function* compensateTicket(cells: TicketCells, ticket: TicketValue) {
    const { command, successorCheck, compensation } = ticket;

    if (
      !NameCommand.guards.Retire(command) ||
      successorCheck === undefined ||
      compensation === undefined
    ) {
      return yield* failure("MailboxUnavailable", 503);
    }

    const reversal =
      successorCheck.previous === null
        ? NameCommand.cases.Clear.make({ name: command.retirement.name })
        : NameCommand.cases.Retire.make({
            holderMayRetire: command.holderMayRetire,
            retirement: successorCheck.previous,
          });

    const reply = yield* applyTicket(cells, {
      command: reversal,
      did: ticket.did,
      expectedVersion: compensation.version,
      opId: `${ticket.opId}/compensate`,
    });

    const settled = yield* settleTicket(ticket, reversal, reply);
    const restored = TicketOutcome.guards.Applied(settled.outcome);

    const consequence = restored
      ? "Previous retirement standing restored."
      : "Previous retirement standing was not restored; the source changed or refused compensation.";

    return {
      outcome: TicketOutcome.cases.Refused.make({
        error: "NameNotFound",
        message: `${compensation.reason} ${consequence}`,
      }),
      state: settled.state,
    };
  }
);

const driveTicket = Effect.fn("Issuer.driveTicket")(function* driveTicket(
  cells: TicketCells,
  ticket: TicketValue
) {
  if (ticket.compensation !== undefined) {
    return yield* compensateTicket(cells, ticket);
  }

  const reply = yield* applyTicket(cells, ticket);
  const check = ticket.successorCheck;

  if (check !== undefined && TicketOutcome.guards.Applied(reply.outcome)) {
    const standing = yield* mailboxCall(() =>
      cells.getByName(check.did).standing()
    );

    if (!standing.exists || standing.retirement !== undefined) {
      const reason = standing.exists
        ? `Successor ${check.name} is now retired.`
        : `Successor ${check.name} is no longer registered.`;

      const store = yield* IssuerStore;

      const next = yield* store.transaction((tx) =>
        tx.beginCompensation(ticket, { reason, version: reply.state.version })
      );

      if (next === undefined) {
        return yield* overtaken();
      }

      return yield* compensateTicket(cells, next);
    }
  }

  return yield* settleTicket(ticket, ticket.command, reply);
});

export const runNameTicket = Effect.fn("Issuer.runNameTicket")(
  function* runNameTicket(
    cells: TicketCells,
    did: string,
    command: NameCommandValue,
    expected?: number,
    successorCheck?: SuccessorCheckValue
  ) {
    const store = yield* IssuerStore;

    const expectedVersion =
      expected ??
      (yield* mailboxCall(() => cells.getByName(did).standingRevision()).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(NameState))),
        Effect.mapError(() => failure("MailboxUnavailable", 503))
      )).version;

    const now = yield* Clock.currentTimeMillis;

    const opId = yield* SecureRandom.SecureRandom.use((random) =>
      random.uuidV4()
    ).pipe(Effect.provide(SecureRandom.layerWebCrypto));

    const base = { command, did, expectedVersion, opId };

    const ticket =
      successorCheck === undefined ? base : { ...base, successorCheck };

    if (!(yield* store.transaction((tx) => tx.writeTicket(ticket, now)))) {
      return yield* failure(
        "MailboxUnavailable",
        503,
        "A standing change is already pending for this name"
      );
    }

    const reply = yield* driveTicket(cells, ticket);

    return yield* TicketOutcome.match(reply.outcome, {
      Applied: ({ cleared }) => Effect.succeed({ cleared, state: reply.state }),
      Refused: ({ error, message }) =>
        Effect.fail(
          failure(error, error === "NameNotFound" ? 404 : 409, message)
        ),
      Superseded: () => Effect.fail(overtaken()),
    });
  }
);

export const drainTickets = Effect.fn("Issuer.drainTickets")(
  function* drainTickets(cells: TicketCells) {
    const store = yield* IssuerStore;
    const now = yield* Clock.currentTimeMillis;
    const tickets = yield* store.transaction((tx) => tx.dueTickets(now));

    return yield* Effect.forEach(
      tickets,
      (ticket) =>
        driveTicket(cells, ticket).pipe(
          Effect.tap(({ outcome }) =>
            TicketOutcome.guards.Refused(outcome)
              ? Effect.logWarning("Standing ticket refused", outcome.message)
              : Effect.void
          ),
          Effect.tapError(() =>
            Effect.logWarning("Standing ticket retry pending")
          ),
          Effect.result
        ),
      { concurrency: 4 }
    );
  }
);
