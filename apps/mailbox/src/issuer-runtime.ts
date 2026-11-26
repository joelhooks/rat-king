/* oxlint-disable typescript/promise-function-async -- Effect adapters require lazy Promise thunks. */
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { Effect, Layer, Schema } from "effect";

import { Caller } from "./caller.ts";
import { failure } from "./failure.ts";
import type { PublicDocument } from "./issuer-policy.ts";
import type { IssuerStore } from "./issuer-store.ts";
import {
  DocumentRegistry,
  issuerHandlers,
  issuerRoute,
  NamedCell,
  respond,
} from "./issuer.ts";
import type { IssuerPolicy } from "./issuer.ts";
import {
  enumeration,
  IssuerEnumeration,
  projectionViews,
} from "./list-names.ts";
import type { ProjectionViews } from "./list-names.ts";
import { NameCommand } from "./name-state.ts";
import { mailboxCall, runNameTicket } from "./name-tickets.ts";
import type { TicketCells } from "./name-tickets.ts";
import { Retirement } from "./store.ts";
import { trafficDid } from "./traffic-store.ts";
import type { Mailbox } from "./worker.ts";

interface IssuerMailboxes extends TicketCells {
  readonly getByName: (
    did: string
  ) => Pick<
    Mailbox,
    | "storeDocument"
    | "retirement"
    | "standing"
    | "standingRevision"
    | "applyStandingTicket"
  >;
}

const readRetirement = (json: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Retirement))(json).pipe(
    Effect.mapError(() => failure("MailboxUnavailable", 503))
  );

const enumerationRequest = Effect.fn("Issuer.enumerationRequest")(
  function* enumerationRequest(request: XrpcRequest) {
    const handlers = yield* IssuerEnumeration;

    if (request.nsid === ListNames.Method.nsid) {
      return yield* respond(
        ListNames.Output,
        Schema.decodeUnknownEffect(ListNames.Params)(request.params ?? {}).pipe(
          Effect.flatMap(handlers.listNames)
        )
      );
    }

    return yield* respond(
      ListRetired.Output,
      Schema.decodeUnknownEffect(ListRetired.Params)(request.params ?? {}).pipe(
        Effect.flatMap(handlers.listRetired)
      )
    );
  }
);

export const routeIssuer = (input: {
  readonly request: XrpcRequest;
  readonly caller: string;
  readonly mailboxes: IssuerMailboxes;
  readonly store: Layer.Layer<IssuerStore>;
  readonly policy: IssuerPolicy;
  readonly views?: ProjectionViews;
  readonly bootstrap?: boolean;
}) => {
  const {
    request,
    caller,
    mailboxes,
    store,
    policy,
    views = projectionViews(),
    bootstrap = false,
  } = input;

  if (
    (!bootstrap && request.nsid === ListNames.Method.nsid) ||
    request.nsid === ListRetired.Method.nsid
  ) {
    return enumerationRequest(request).pipe(
      Effect.provide(enumeration(views).pipe(Layer.provide(store)))
    );
  }

  const registry = Layer.succeed(
    DocumentRegistry,
    DocumentRegistry.of({
      put: Effect.fn("DocumentRegistry.put")(function* put(
        document: PublicDocument
      ) {
        if (document.id === trafficDid) {
          return yield* failure("Forbidden", 403);
        }

        const outcome = yield* mailboxCall(() =>
          mailboxes
            .getByName(document.id)
            .storeDocument(JSON.stringify(document))
        );

        if (outcome === "DocumentConflict") {
          return yield* failure("DocumentConflict", 409);
        }

        if (outcome !== "stored") {
          return yield* failure("MailboxUnavailable", 503);
        }

        return yield* Effect.void;
      }),
    })
  );

  const named = Layer.succeed(
    NamedCell,
    NamedCell.of({
      clear: (did, name, expected) =>
        runNameTicket(
          mailboxes,
          did,
          NameCommand.cases.Clear.make({ name }),
          expected
        ).pipe(
          Effect.map(({ cleared }) => cleared),
          Effect.provide(store)
        ),
      current: Effect.fn("NamedCell.current")(function* current(did) {
        const json = yield* mailboxCall(() =>
          mailboxes.getByName(did).retirement()
        );

        return json === undefined ? undefined : yield* readRetirement(json);
      }),
      presence: Effect.fn("NamedCell.presence")(function* presence(did) {
        const { retirement, ...standing } = yield* mailboxCall(() =>
          mailboxes.getByName(did).standing()
        );

        return retirement === undefined
          ? standing
          : { ...standing, retirement: yield* readRetirement(retirement) };
      }),
      repoint: Effect.fn("NamedCell.repoint")(
        function* repoint(did, successor, updatedAt) {
          const { state } = yield* runNameTicket(
            mailboxes,
            did,
            NameCommand.cases.Repoint.make({ successor, updatedAt })
          ).pipe(Effect.provide(store));

          return (
            state.retirement ?? (yield* failure("MailboxUnavailable", 503))
          );
        }
      ),
      retire: (did, retirement, holderMayRetire, expected, successorCheck) =>
        did === trafficDid
          ? Effect.fail(failure("Forbidden", 403))
          : runNameTicket(
              mailboxes,
              did,
              NameCommand.cases.Retire.make({ holderMayRetire, retirement }),
              expected,
              successorCheck
            ).pipe(
              Effect.map(({ state }) => state.version),
              Effect.provide(store)
            ),
    })
  );

  return issuerRoute(request).pipe(
    Effect.provide(
      issuerHandlers(policy, views, bootstrap).pipe(
        Layer.provide(store),
        Layer.provide(registry),
        Layer.provide(named),
        Layer.provide(Layer.succeed(Caller, { did: caller }))
      )
    )
  );
};
