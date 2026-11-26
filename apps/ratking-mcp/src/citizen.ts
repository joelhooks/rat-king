// @effect-diagnostics nodeBuiltinImport:off -- The host adapter binds an OS Unix socket and hashes opaque wake tokens.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Inbox, NotDelivered } from "@rat-king/ratking-client/ratking";
import type { Peeked } from "@rat-king/ratking-client/ratking";
import { Effect, Layer, Logger, Schedule, Semaphore } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";

import { clientLayer } from "./main.ts";
import { entry, registration } from "./tools.ts";

const BATCH_SIZE = 16;

const refused = (reason: string) =>
  new NotDelivered({ code: "NotAttempted", reason });

interface Waiting {
  readonly item: Peeked;
  readonly ack: Effect.Effect<void, NotDelivered>;
}

export const makeCitizen = Effect.fn("RatKingMcp.makeCitizen")(
  function* makeCitizen(name: string) {
    const inbox = yield* Inbox;
    const identity = yield* inbox.attach(name);
    const lock = yield* Semaphore.make(1);
    const waiting = new Map<string, Waiting>();
    let live = false;

    const needLease = Effect.suspend(() =>
      live
        ? Effect.void
        : Effect.fail(
            refused("The citizen reader is not caught up under a live lease")
          )
    );

    const current = () => {
      const batch: Waiting[] = [];

      for (const item of waiting.values()) {
        batch.push(item);

        if (batch.length === BATCH_SIZE) {
          break;
        }
      }

      return batch;
    };

    yield* inbox
      .follow(
        (item, ack) =>
          lock.withPermit(
            Effect.sync(() => {
              waiting.set(item.received.id, { ack, item });
            })
          ),
        {
          ready: Effect.sync(() => {
            live = true;
          }),
          retrying: Effect.sync(() => {
            live = false;
          }),
          session: `mcp-citizen-${process.pid}`,
        }
      )
      .pipe(
        Effect.ensuring(
          lock.withPermit(
            Effect.sync(() => {
              live = false;
              waiting.clear();
            })
          )
        ),
        Effect.catch(() =>
          Effect.logWarning(
            "Rat King citizen intake stopped; checking the lease again"
          )
        ),
        Effect.repeat(Schedule.spaced("2 seconds")),
        Effect.forkScoped
      );

    return {
      ack: (ids: readonly string[]) =>
        lock.withPermit(
          Effect.gen(function* ackBatch() {
            yield* needLease;
            const batch = current();

            if (
              ids.length === 0 ||
              ids.some((id, index) => batch[index]?.item.received.id !== id)
            ) {
              return yield* refused(
                "Only the handled prefix of the current inbox batch can be acknowledged"
              );
            }

            const acked: string[] = [];

            for (const item of batch.slice(0, ids.length)) {
              yield* item.ack;
              const { id } = item.item.received;
              waiting.delete(id);
              acked.push(id);
            }

            yield* Effect.logInfo("Rat King citizen batch acknowledged", {
              count: acked.length,
              name,
            });

            return { acked };
          })
        ),
      batch: needLease.pipe(
        Effect.map(() => ({
          hasMore: waiting.size > BATCH_SIZE,
          messages: current().map(({ item }) => entry(item)),
        }))
      ),
      identity,
      ready: needLease,
      wake: needLease.pipe(
        Effect.map(() => {
          const wakes = [...waiting.values()].some(
            ({ item: { received } }) =>
              received.cc !== true &&
              !("quiet" in received && received.quiet !== undefined)
          );

          const first = waiting.values().next().value;

          return {
            batch:
              first === undefined
                ? null
                : createHash("sha256")
                    .update(first.item.received.id)
                    .digest("hex"),
            wakes,
          };
        })
      ),
    };
  }
);

export const citizenServer = (name: string, socket: string) =>
  HttpRouter.serve(
    Layer.unwrap(
      Effect.map(makeCitizen(name), (citizen) =>
        registration(name, citizen).pipe(
          Layer.provide(
            McpServer.layerHttp({
              allowSessionTermination: true,
              name: "ratking-citizen",
              path: "/mcp",
              protocols: [McpProtocol.v2025_03_26],
              version: "0.1.0",
            })
          )
        )
      )
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provide(clientLayer),
    Layer.provide(NodeHttpServer.layer(createServer, { path: socket })),
    Layer.provide(Layer.succeed(Logger.LogToStderr, true))
  );
