/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Durable Object callbacks return Effect-run promises. */
import * as Subscribe from "@rat-king/lexicon/mailbox.subscribeTraffic";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Clock, Effect, Schema } from "effect";
import { transition } from "xstate";

import type { ClaimsValue } from "./auth.ts";
import { failure } from "./failure.ts";
import { socketMachine, socketCodes } from "./socket.ts";

const Attachment = Schema.Struct({
  deadline: Schema.Int,
  expiresAt: Schema.Int,
  state: Schema.Literals([
    "awaitingAuth",
    "authenticating",
    "authenticated",
    "closed",
  ]),
});

const step = (socket: WebSocket, type: "authenticate" | "accept" | "close") => {
  const attachment = Schema.decodeUnknownSync(Attachment)(
    socket.deserializeAttachment()
  );

  const [next] = transition(
    socketMachine,
    socketMachine.resolveState({ context: {}, value: attachment.state }),
    { type }
  );

  socket.serializeAttachment(
    Schema.decodeUnknownSync(Attachment)({ ...attachment, state: next.value })
  );
};

const close = (socket: WebSocket, code: number) => {
  step(socket, "close");
  socket.close(code, "Traffic authentication expired or refused");
};

const notice = (socket: WebSocket, seq: number) => {
  socket.send(
    JSON.stringify({
      $type: "sh.mschf.ratking.mailbox.subscribeTraffic#notice",
      seq,
    })
  );
};

export const trafficSockets = (
  ctx: DurableObjectState,
  authenticate: (token: string) => Effect.Effect<ClaimsValue, XrpcFailure>,
  watermark: () => number
) => ({
  alarm: () => {
    const now = Effect.runSync(Clock.currentTimeMillis);
    let deadline = Number.POSITIVE_INFINITY;

    for (const socket of ctx.getWebSockets()) {
      const attachment = Schema.decodeUnknownSync(Attachment)(
        socket.deserializeAttachment()
      );

      if (attachment.state === "closed") {
        continue;
      }

      const until =
        attachment.state === "authenticated"
          ? attachment.expiresAt
          : attachment.deadline;

      if (now >= until) {
        close(socket, socketCodes.timeout);
      } else {
        deadline = Math.min(deadline, until);
      }
    }

    return Number.isFinite(deadline)
      ? ctx.storage.setAlarm(deadline)
      : Promise.resolve();
  },
  broadcast: () => {
    const now = Effect.runSync(Clock.currentTimeMillis);

    for (const socket of ctx.getWebSockets()) {
      const attachment = Schema.decodeUnknownSync(Attachment)(
        socket.deserializeAttachment()
      );

      if (attachment.state === "authenticated") {
        if (now >= attachment.expiresAt) {
          close(socket, socketCodes.timeout);
        } else {
          notice(socket, watermark());
        }
      }
    }
  },
  close: (socket: WebSocket) => {
    step(socket, "close");
  },
  fetch: (request: Request) =>
    Effect.runPromise(
      Effect.gen(function* upgrade() {
        const url = new URL(request.url);

        if (
          request.method !== "GET" ||
          request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          url.search !== ""
        ) {
          return Response.json({ error: "InvalidRequest" }, { status: 400 });
        }

        if (ctx.getWebSockets().length >= 32) {
          return Response.json(
            { error: "MailboxUnavailable" },
            { status: 503 }
          );
        }

        const [server, client] = Object.values(new WebSocketPair());

        if (!server || !client) {
          return Response.json(
            { error: "MailboxUnavailable" },
            { status: 503 }
          );
        }

        const now = yield* Clock.currentTimeMillis;
        ctx.acceptWebSocket(server);
        server.serializeAttachment({
          deadline: now + 5000,
          expiresAt: now + 60_000,
          state: "awaitingAuth",
        });
        const alarm = yield* Effect.promise(() => ctx.storage.getAlarm());

        if (alarm === null || alarm > now + 5000) {
          yield* Effect.promise(() => ctx.storage.setAlarm(now + 5000));
        }

        return new Response(null, { status: 101, webSocket: client });
      })
    ),
  message: (socket: WebSocket, message: string | ArrayBuffer) =>
    Effect.runPromise(
      Effect.gen(function* authorize() {
        const attachment = yield* Schema.decodeUnknownEffect(Attachment)(
          socket.deserializeAttachment()
        );

        if (
          attachment.state !== "awaitingAuth" ||
          (yield* Clock.currentTimeMillis) >= attachment.deadline
        ) {
          return yield* Effect.fail(failure("AuthRequired", 401));
        }

        step(socket, "authenticate");

        const auth = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              $type: Schema.Literal(
                "sh.mschf.ratking.mailbox.subscribeTraffic#auth"
              ),
              token: Subscribe.Auth.schema.fields.token,
            })
          )
        )(message);

        const claims = yield* authenticate(auth.token);

        const current = yield* Schema.decodeUnknownEffect(Attachment)(
          socket.deserializeAttachment()
        );

        if (
          current.state !== "authenticating" ||
          (yield* Clock.currentTimeMillis) >=
            Math.min(current.deadline, claims.exp * 1000)
        ) {
          return yield* Effect.fail(failure("AuthRequired", 401));
        }

        socket.serializeAttachment({
          ...current,
          expiresAt: Math.min(current.expiresAt, claims.exp * 1000),
        });
        step(socket, "accept");
        notice(socket, watermark());

        return yield* Effect.void;
      }).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.sync(() => {
            close(socket, socketCodes.auth);
          })
        ),
        Effect.catchTag("XrpcFailure", () =>
          Effect.sync(() => {
            close(socket, socketCodes.auth);
          })
        )
      )
    ),
});
