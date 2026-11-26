// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem cannot inspect an inherited descriptor.
import { fstatSync } from "node:fs";
import { Socket } from "node:net";

import { lowS } from "@rat-king/envelope";
import type { ManagedIdentity } from "@rat-king/mailbox-client/identity";
import { Config, Effect, Schema, Semaphore } from "effect";
import { constVoid } from "effect/Function";

import {
  frameLimit,
  grantFailure,
  Request,
  Response,
} from "./desk-signer-wire.ts";

export const signerFd = Config.option(Config.Int("RATKING_SIGNER_FD"));

const makeChannel = (socket: Socket) => {
  const permit = Semaphore.makeUnsafe(1);
  socket.on("error", () => {
    socket.destroy();
  });

  return Effect.fn("DeskSigner.exchange")(
    function* exchange(input: typeof Request.Type) {
      const line = yield* Schema.encodeEffect(Request)(input).pipe(
        Effect.mapError(grantFailure)
      );

      if (Buffer.byteLength(line) >= frameLimit) {
        return yield* grantFailure();
      }

      const response = yield* Effect.callback<
        string,
        ReturnType<typeof grantFailure>
      >((resume) => {
        if (socket.destroyed || socket.readableEnded) {
          resume(Effect.fail(grantFailure()));

          return Effect.void;
        }

        let pending = Buffer.alloc(0);
        let cleanup = constVoid;

        const closed = () => {
          cleanup();
          resume(Effect.fail(grantFailure()));
        };

        const receive = (chunk: Buffer) => {
          if (pending.length + chunk.length > frameLimit) {
            socket.destroy();

            return;
          }

          pending = Buffer.concat([pending, chunk]);
          const end = pending.indexOf(10);

          if (end === -1) {
            return;
          }

          if (end !== pending.length - 1) {
            socket.destroy();

            return;
          }

          cleanup();
          resume(Effect.succeed(pending.toString("utf-8", 0, end)));
        };

        cleanup = () => {
          socket.off("data", receive);
          socket.off("close", closed);
        };

        socket.on("data", receive);
        socket.once("close", closed);
        socket.write(`${line}\n`);

        return Effect.sync(() => {
          cleanup();
          socket.destroy();
        });
      }).pipe(Effect.timeout("3 seconds"), Effect.mapError(grantFailure));

      return yield* Schema.decodeEffect(Response)(response, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(grantFailure));
    },
    (effect) => permit.withPermit(effect)
  );
};

const channels = new Map<number, ReturnType<typeof makeChannel>>();

const channelFor = (fd: number) =>
  Effect.try({
    catch: grantFailure,
    try: () => {
      const current = channels.get(fd);

      if (current !== undefined) {
        return current;
      }

      if (fd < 3 || !fstatSync(fd).isSocket()) {
        throw grantFailure();
      }

      const channel = makeChannel(
        new Socket({ fd, readable: true, writable: true })
      );

      channels.set(fd, channel);

      return channel;
    },
  });

type Exchange = ReturnType<typeof makeChannel>;

export const identityFromGrant = Effect.fn("DeskSigner.identity")(
  function* identityFromGrant(exchange: Exchange, name: string, did: string) {
    const description = yield* exchange({ kind: "describe" });

    if (
      description.kind !== "describe" ||
      description.identity.name !== name ||
      description.identity.did !== did
    ) {
      return yield* grantFailure();
    }

    const bytes = (request: typeof Request.Type) =>
      exchange(request).pipe(
        Effect.flatMap((response) =>
          response.kind === "bytes"
            ? Effect.succeed(response.data)
            : Effect.fail(grantFailure())
        )
      );

    const { agreement, signing } = description.identity;

    return {
      agreement,
      did,
      open: (envelope) => bytes({ envelope, kind: "open" }),
      sign: (input) =>
        bytes({ bytes: input, kind: "sign" }).pipe(
          Effect.filterOrFail(lowS, grantFailure)
        ),
      signing,
    } satisfies ManagedIdentity;
  }
);

export const bindDeskSigner = Effect.fn("DeskSigner.bind")(
  function* bindDeskSigner(fd: number, name: string, did: string) {
    const exchange = yield* channelFor(fd);

    return yield* identityFromGrant(exchange, name, did);
  }
);
