import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import type { SessionFacts } from "@rat-king/ratking-client/identity";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import type { Deliver } from "@rat-king/ratking-client/ratking";
import {
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  Scope,
} from "effect";
import { flow } from "effect/Function";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as fc from "fast-check";

import { WebSocketPort } from "../../mailbox-client/src/watch.ts";
import { fakeMailbox } from "./fake-mailbox.ts";
import type { harness } from "./harness.ts";

type TestResponse =
  | { readonly error: string }
  | { readonly released: boolean }
  | {
      readonly lease: Omit<Acquire.InputValue, "expiresAt"> & {
        readonly expiresAt: string;
        readonly generation: number;
        readonly leaseId: string;
      };
    }
  | { readonly receipt: Partial<Defs.ReceiptValue> };

const fenceBlocked = (
  active: boolean,
  input: Acquire.InputValue,
  generation: number
) =>
  active &&
  (input.generation !== generation || input.leaseId !== "3mxcx45mn7sex");

export const successorMailbox = () => {
  const mailbox = fakeMailbox("accept");
  const sockets: EventTarget[] = [];
  const events: Defs.MessageEventValue[] = [];
  const attempts: Acquire.InputValue[] = [];
  let lease: Acquire.InputValue | undefined;
  let generation = 0;
  let until = 0;
  let releaseFails = false;
  let maximum = 0;
  const leases = new Set<string>();
  const log: string[] = [];

  const notify = () => {
    for (const target of sockets) {
      target.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ seq: events.length }),
        })
      );
    }
  };

  const http = HttpClient.make((request) =>
    Effect.gen(function* serve() {
      const url = new URL(request.url);
      const nsid = url.pathname;
      const now = yield* Clock.currentTimeMillis;

      const body = Predicate.isTagged(request.body, "Uint8Array")
        ? new TextDecoder().decode(request.body.body)
        : "{}";

      const response = (value: TestResponse, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(value, { status }));

      if (nsid.endsWith(".acquireLease")) {
        const input = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Acquire.Input)
        )(body).pipe(Effect.orDie);

        attempts.push(input);

        const active = lease !== undefined && until > now;

        if (fenceBlocked(active, input, generation)) {
          return response({ error: "LeaseHeld" }, 409);
        }

        if (!active) {
          leases.clear();
        }

        if (!active || input.harness.sessionId !== lease?.harness.sessionId) {
          generation += 1;
        }

        lease = input;
        until = now + 300_000;

        const session = Schema.decodeUnknownOption(Schema.String)(
          input.harness.sessionId
        ).pipe(Option.getOrElse(() => "unknown"));

        leases.add(session);
        maximum = Math.max(maximum, leases.size);
        log.push(`acquire:${session}`);

        return response({
          lease: {
            ...input,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(until)),
            generation,
            leaseId: "3mxcx45mn7sex",
          },
        });
      }

      if (nsid.endsWith(".resolveLease")) {
        return lease !== undefined && until > now
          ? response({
              lease: {
                ...lease,
                expiresAt: DateTime.formatIso(DateTime.makeUnsafe(until)),
                generation,
                leaseId: "3mxcx45mn7sex",
              },
            })
          : response({ error: "LeaseNotFound" }, 404);
      }

      if (nsid.endsWith(".releaseLease")) {
        if (releaseFails) {
          return response({ error: "MailboxUnavailable" }, 503);
        }

        leases.clear();
        until = 0;
        log.push("release");

        return response({ released: true });
      }

      if (nsid.endsWith(".list")) {
        const after = Number(url.searchParams.get("afterSeq") ?? 0);

        const json = yield* Schema.encodeEffect(
          Schema.fromJsonString(List.Output)
        )({
          events: events.flatMap((event) =>
            event.seq > after
              ? [
                  {
                    ...event,
                    $type: "sh.mschf.ratking.defs#messageEvent" as const,
                  },
                ]
              : []
          ),
          throughSeq: events.length,
        }).pipe(Effect.orDie);

        return HttpClientResponse.fromWeb(
          request,
          new Response(json, {
            headers: { "content-type": "application/json" },
          })
        );
      }

      if (nsid.endsWith(".deliver") || nsid.endsWith(".ack")) {
        const input = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ message: Defs.MessageRef }))
        )(body).pipe(Effect.orDie);

        const event = events.find(
          (item) => item.receipt.message.messageId === input.message.messageId
        );

        return response({
          receipt: {
            ...event?.receipt,
            state: nsid.endsWith(".ack") ? "acked" : "delivered",
          },
        });
      }

      return yield* mailbox.http.execute(request);
    })
  );

  const socket = Layer.succeed(WebSocketPort, {
    connect: () => {
      const target = new EventTarget();
      sockets.push(target);

      return {
        addEventListener: target.addEventListener.bind(target),
        close: () => {
          const index = sockets.indexOf(target);

          if (index !== -1) {
            sockets.splice(index, 1);
          }
        },
        readyState: 1,
        removeEventListener: target.removeEventListener.bind(target),
        send: notify,
      };
    },
  });

  return {
    attempts,
    events,
    expire: () => {
      until = 0;
      leases.clear();
    },
    failRelease: () => {
      releaseFails = true;
    },
    http,
    log,
    maximum: () => maximum,
    notify,
    requests: mailbox.requests,
    socket,
  };
};

export const startReader = (
  layer: ReturnType<typeof harness>,
  facts: SessionFacts
) =>
  Effect.gen(function* bootReader() {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.buildWithScope(layer, scope);
    const king = yield* RatKing.pipe(Effect.provideContext(context));
    const live = yield* Deferred.make<boolean>();
    const held = yield* Deferred.make<boolean>();

    const deliveries = yield* Queue.unbounded<{
      readonly inbound: Parameters<Deliver>[0];
      readonly ack: Effect.Effect<void>;
    }>();

    const run = king.run(
      {
        ...facts,
        onState: (state) => {
          if (ReaderState.$is("Live")(state)) {
            Deferred.doneUnsafe(live, Exit.succeed(true));
          }

          if (ReaderState.$is("SendOnly")(state)) {
            Deferred.doneUnsafe(held, Exit.succeed(true));
          }
        },
      },
      (inbound, _settled, ack) =>
        Queue.offer(deliveries, { ack: ack ?? Effect.void, inbound }).pipe(
          Effect.asVoid
        )
    );

    yield* run.pipe(
      Effect.provideContext(Context.add(context, Scope.Scope, scope))
    );

    return {
      deliveries,
      held: Deferred.await(held),
      king,
      live: Deferred.await(live),
      stop: Scope.close(scope, Exit.void),
    };
  });

export const runModel = <M extends object, S, E, R>(
  steps: readonly S[],
  model: M,
  action: (model: M, step: S) => Effect.Effect<void, E, R>
) =>
  Effect.gen(function* executeModel() {
    const context = yield* Effect.context<R>();

    const commands = steps.map((step): fc.AsyncCommand<M, object> => ({
      check: () => true,
      run: flow(
        (state: M) => action(state, step),
        Effect.runPromiseWith(context)
      ),
      toString: () => JSON.stringify(step),
    }));

    yield* Effect.promise(
      fc.asyncModelRun.bind(
        null,
        () => ({ model, real: createEventBus() }),
        commands
      )
    );
  });
