/* oxlint-disable eslint/max-classes-per-file -- Effect service ports share their owning desk module. */
import * as Ack from "@rat-king/lexicon/desk.ack";
import * as BindProject from "@rat-king/lexicon/desk.bindProject";
import * as DeskDefs from "@rat-king/lexicon/desk.defs";
import * as Fork from "@rat-king/lexicon/desk.fork";
import * as Inbox from "@rat-king/lexicon/desk.inbox";
import * as Ingest from "@rat-king/lexicon/desk.ingest";
import * as Pending from "@rat-king/lexicon/desk.pending";
import * as RememberReply from "@rat-king/lexicon/desk.rememberReply";
import * as ReplyFor from "@rat-king/lexicon/desk.replyFor";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import {
  digestOrder,
  facetsInRange,
  mentions,
  ownerCid,
  withinCaps,
} from "@rat-king/mailbox-client/owner-queue";
import {
  Array as Arr,
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Order,
  Schema,
} from "effect";

import { Caller } from "./caller.ts";
import { DeskStore } from "./desk-store.ts";
import type { DeskSnapshotValue } from "./desk-store.ts";
import { failure } from "./failure.ts";
import { respond } from "./issuer.ts";

export const deskMethods = [
  Ingest.Method,
  Inbox.Method,
  Ack.Method,
  Pending.Method,
  Fork.Method,
  RememberReply.Method,
  ReplyFor.Method,
  BindProject.Method,
];

const pendingWindow = 200;

export class DeskRegistry extends Context.Service<
  DeskRegistry,
  {
    readonly parent: (
      destination: string
    ) => Effect.Effect<string | undefined, XrpcFailure>;
    readonly snapshot: (
      did: string,
      atSeq: number
    ) => Effect.Effect<DeskSnapshotValue, XrpcFailure>;
  }
>()("mailbox/DeskRegistry") {}

export class DeskHandlers extends Context.Service<
  DeskHandlers,
  {
    readonly ingest: (
      input: Ingest.InputValue
    ) => Effect.Effect<Ingest.OutputValue, XrpcFailure>;
    readonly inbox: (
      params: Inbox.ParamsValue
    ) => Effect.Effect<Inbox.OutputValue, XrpcFailure>;
    readonly ack: (
      input: Ack.InputValue
    ) => Effect.Effect<Ack.OutputValue, XrpcFailure>;
    readonly pending: (
      params: Pending.ParamsValue
    ) => Effect.Effect<Pending.OutputValue, XrpcFailure>;
    readonly fork: (
      input: Fork.InputValue
    ) => Effect.Effect<Fork.OutputValue, XrpcFailure>;
    readonly rememberReply: (
      input: RememberReply.InputValue
    ) => Effect.Effect<RememberReply.OutputValue, XrpcFailure>;
    readonly replyFor: (
      params: ReplyFor.ParamsValue
    ) => Effect.Effect<ReplyFor.OutputValue, XrpcFailure>;
    readonly bindProject: (
      input: BindProject.InputValue
    ) => Effect.Effect<BindProject.OutputValue, XrpcFailure>;
  }
>()("mailbox/DeskHandlers") {}

const millis = (datetime: string) =>
  Option.match(DateTime.make(datetime), {
    onNone: () => Effect.fail(failure("InvalidRequest", 400, "Bad datetime")),
    onSome: (value) => Effect.succeed(DateTime.toEpochMillis(value)),
  });

const createdAt = (entry: DeskDefs.QueuedValue) =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(entry.item.createdAt));

const vacant = (empty: boolean) => {
  if (!empty) {
    throw failure("DeskNotEmpty", 409);
  }
};

export const deskHandlers = (desk: string, operators: readonly string[]) => {
  const addressed = (did: string) =>
    did === desk
      ? Effect.void
      : Effect.fail(failure("InvalidRequest", 400, "Wrong desk"));

  return Layer.effect(
    DeskHandlers,
    Effect.gen(function* makeDeskHandlers() {
      const store = yield* DeskStore;
      const registry = yield* DeskRegistry;
      const caller = yield* Caller;

      const owner = (did: string) =>
        addressed(did).pipe(
          Effect.andThen(
            caller.did === desk
              ? Effect.void
              : Effect.fail(failure("Forbidden", 403))
          )
        );

      return DeskHandlers.of({
        ack: Effect.fn("Desk.ack")(function* ack(input) {
          yield* owner(input.desk);

          return yield* store.transaction((tx) => ({
            acked: tx.ack(input.uris),
            deliveredThrough: tx.deliveredThrough(),
          }));
        }),
        bindProject: Effect.fn("Desk.bindProject")(
          function* bindProject(input) {
            yield* owner(input.desk);

            return yield* store.transaction((tx) => {
              const bound = tx.project();

              if (bound !== undefined && bound !== input.project) {
                throw failure("ProjectConflict", 409);
              }

              tx.bindProject(input.project);

              return { project: input.project };
            });
          }
        ),
        fork: Effect.fn("Desk.fork")(function* fork(input) {
          yield* addressed(input.desk);

          if (caller.did !== input.fromDid) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          if (input.fromDid === input.desk) {
            return yield* Effect.fail(
              failure("InvalidRequest", 400, "A desk cannot fork into itself")
            );
          }

          if (
            !operators.includes(caller.did) &&
            (yield* registry.parent(input.desk)) !== caller.did
          ) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          yield* store.transaction((tx) => {
            vacant(tx.empty());
          });

          const snapshot = yield* registry.snapshot(input.fromDid, input.atSeq);

          yield* store.transaction((tx) => {
            vacant(tx.empty());
            tx.seed(snapshot);
          });

          return {
            atSeq: input.atSeq,
            copied: snapshot.items.length,
            deliveredThrough: snapshot.deliveredThrough,
            desk: input.desk,
            fromDid: input.fromDid,
          };
        }),
        inbox: Effect.fn("Desk.inbox")(function* inbox(params) {
          yield* owner(params.desk);

          const limit = params.limit ?? Inbox.Method.defaults.limit;

          const since =
            params.since === undefined
              ? undefined
              : yield* millis(params.since);

          return yield* store.transaction((tx) => ({
            deliveredThrough: tx.deliveredThrough(),
            items:
              since === undefined
                ? tx.undelivered(limit)
                : tx.since(since, limit),
          }));
        }),
        ingest: Effect.fn("Desk.ingest")(function* ingest(input) {
          yield* addressed(input.desk);

          const { item } = input;

          if (caller.did !== desk && caller.did !== item.author) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          if (!withinCaps(item.text) || !facetsInRange(item)) {
            return yield* Effect.fail(
              failure("InvalidRequest", 400, "Text cap or facet range")
            );
          }

          const { cid, ...content } = yield* Schema.encodeEffect(
            DeskDefs.OwnerItem
          )(item).pipe(Effect.mapError(() => failure("InvalidRequest")));

          const computed = yield* ownerCid(content).pipe(
            Effect.mapError(() => failure("MailboxUnavailable", 503))
          );

          if (computed !== cid) {
            return yield* Effect.fail(failure("CidInvalid"));
          }

          const created = yield* millis(item.createdAt);

          const outcome = yield* store.transaction((tx) => {
            const held = tx.held(item.uri);

            if (held !== undefined) {
              return held.cid === cid
                ? ({ seq: held.seq, stored: false } as const)
                : ({ held: held.cid } as const);
            }

            const project = tx.project();

            if (
              project !== undefined &&
              item.project !== undefined &&
              item.project !== project
            ) {
              throw failure("ProjectMismatch", 409);
            }

            return { seq: tx.insert(item, created), stored: true } as const;
          });

          if ("held" in outcome) {
            yield* Effect.logWarning(
              "Desk refused an item whose uri it holds with another cid"
            ).pipe(
              Effect.annotateLogs({
                author: item.author,
                desk,
                held: outcome.held,
                offered: cid,
                uri: item.uri,
              })
            );

            return yield* Effect.fail(failure("CidConflict", 409));
          }

          return outcome;
        }),
        pending: Effect.fn("Desk.pending")(function* pending(params) {
          yield* owner(params.desk);

          const now = yield* Clock.currentTimeMillis;

          const undelivered = yield* store.transaction((tx) =>
            tx.undelivered(pendingWindow + 1)
          );

          const window = undelivered.slice(0, pendingWindow);

          const [oldest] = Arr.sort(
            window.filter((entry) => !mentions(entry.item, desk)),
            Order.mapInput(Order.Number, createdAt)
          );

          const view = {
            covered: window.map((entry) => entry.item.uri),
            digest: digestOrder(window, desk),
            mentions: window.filter((entry) => mentions(entry.item, desk)),
            more: undelivered.length > pendingWindow,
          };

          return oldest === undefined
            ? view
            : {
                ...view,
                oldestQuietAgeMs: Math.max(0, now - createdAt(oldest)),
                oldestQuietAt: oldest.item.createdAt,
              };
        }),
        rememberReply: Effect.fn("Desk.rememberReply")(
          function* rememberReply(input) {
            yield* owner(input.desk);

            return yield* store.transaction((tx) => ({
              messageId: tx.remember(input.uri, input.messageId),
              uri: input.uri,
            }));
          }
        ),
        replyFor: Effect.fn("Desk.replyFor")(function* replyFor(params) {
          yield* owner(params.desk);

          const messageId = yield* store.transaction((tx) =>
            tx.reply(params.uri)
          );

          return messageId === undefined
            ? { uri: params.uri }
            : { messageId, uri: params.uri };
        }),
      });
    })
  );
};

export const deskRoute = Effect.fn("Desk.route")(function* deskRoute(
  request: XrpcRequest
) {
  const handlers = yield* DeskHandlers;

  switch (request.nsid) {
    case Ingest.Method.nsid: {
      return yield* respond(
        Ingest.Output,
        Schema.decodeUnknownEffect(Ingest.Input)(request.input).pipe(
          Effect.flatMap(handlers.ingest)
        )
      );
    }

    case Inbox.Method.nsid: {
      return yield* respond(
        Inbox.Output,
        Schema.decodeUnknownEffect(Inbox.Params)(request.params ?? {}).pipe(
          Effect.flatMap(handlers.inbox)
        )
      );
    }

    case Ack.Method.nsid: {
      return yield* respond(
        Ack.Output,
        Schema.decodeUnknownEffect(Ack.Input)(request.input).pipe(
          Effect.flatMap(handlers.ack)
        )
      );
    }

    case Pending.Method.nsid: {
      return yield* respond(
        Pending.Output,
        Schema.decodeUnknownEffect(Pending.Params)(request.params ?? {}).pipe(
          Effect.flatMap(handlers.pending)
        )
      );
    }

    case Fork.Method.nsid: {
      return yield* respond(
        Fork.Output,
        Schema.decodeUnknownEffect(Fork.Input)(request.input).pipe(
          Effect.flatMap(handlers.fork)
        )
      );
    }

    case RememberReply.Method.nsid: {
      return yield* respond(
        RememberReply.Output,
        Schema.decodeUnknownEffect(RememberReply.Input)(request.input).pipe(
          Effect.flatMap(handlers.rememberReply)
        )
      );
    }

    case ReplyFor.Method.nsid: {
      return yield* respond(
        ReplyFor.Output,
        Schema.decodeUnknownEffect(ReplyFor.Params)(request.params ?? {}).pipe(
          Effect.flatMap(handlers.replyFor)
        )
      );
    }

    case BindProject.Method.nsid: {
      return yield* respond(
        BindProject.Output,
        Schema.decodeUnknownEffect(BindProject.Input)(request.input).pipe(
          Effect.flatMap(handlers.bindProject)
        )
      );
    }

    default: {
      return {
        body: JSON.stringify({ error: "InvalidRequest" }),
        status: 404,
      };
    }
  }
});
