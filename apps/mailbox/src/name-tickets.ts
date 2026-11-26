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
import type { NameCommandValue, TicketValue } from "./name-state.ts";

export interface TicketCells {
  readonly getByName: (did: string) => {
    readonly applyStandingTicket: (json: string) => Promise<string>;
    readonly standingRevision: () => Promise<string>;
  };
}

export const mailboxCall = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => failure("MailboxUnavailable", 503),
    try: call,
  });

const driveTicket = Effect.fn("Issuer.driveTicket")(function* driveTicket(
  cells: TicketCells,
  ticket: TicketValue
) {
  const store = yield* IssuerStore;

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

  return yield* store.transaction((tx) => {
    const pending = tx.finishTicket(ticket);
    const before = tx.observation(ticket.did);
    tx.observe(reply.state);
    const current = tx.observation(ticket.did);

    if (current === undefined || current.version > reply.state.version) {
      return {
        outcome: TicketOutcome.cases.Superseded.make({}),
        state: current ?? reply.state,
      };
    }

    if (pending && !TicketOutcome.guards.Refused(reply.outcome)) {
      if (current.retirement !== null) {
        tx.retire({ ...current.retirement, did: current.did });
      } else if (
        TicketOutcome.guards.Applied(reply.outcome) &&
        NameCommand.guards.Clear(ticket.command)
      ) {
        tx.unretire(ticket.command.name);
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

export const runNameTicket = Effect.fn("Issuer.runNameTicket")(
  function* runNameTicket(
    cells: TicketCells,
    did: string,
    command: NameCommandValue,
    expected?: number
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

    const ticket = { command, did, expectedVersion, opId };

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
      Superseded: () =>
        Effect.fail(
          failure(
            "MailboxUnavailable",
            503,
            "Standing changed while this operation was in flight; retry against the current revision"
          )
        ),
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
          Effect.tapError(() =>
            Effect.logWarning("Standing ticket retry pending")
          ),
          Effect.result
        ),
      { concurrency: 4 }
    );
  }
);
