import * as Subscribe from "@rat-king/lexicon/mailbox.subscribe";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Option,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { Socket } from "effect/socket";

import { base64url, serviceToken } from "./auth.ts";
import { clientError, MailboxClientError } from "./error.ts";
import { importSigning } from "./identity.ts";
import type { Batch, ClientConfig, LeaseFence } from "./mailbox.ts";

export class WebSocketPort extends Context.Service<
  WebSocketPort,
  {
    readonly connect: (url: string) => Socket.WebSocketLike;
  }
>()("@rat-king/mailbox-client/WebSocketPort") {}

const socketError = (error: Socket.SocketError) => {
  if (Predicate.isTagged(error.reason, "SocketCloseError")) {
    if (error.reason.code === 4409) {
      return new MailboxClientError({
        error: "LeaseMismatch",
        reason: "Mailbox subscription lease changed",
      });
    }

    if (error.reason.code === 4401) {
      return new MailboxClientError({
        error: "AuthRequired",
        reason: "Mailbox subscription authentication refused",
      });
    }
  }

  return new MailboxClientError({
    error: "SocketDisconnected",
    reason: "Mailbox subscription disconnected",
  });
};

export const watch = (
  config: ClientConfig,
  poll: (afterSeq: number) => Effect.Effect<Batch, MailboxClientError>,
  afterSeq: number,
  fence: LeaseFence
): Stream.Stream<Batch, MailboxClientError> =>
  Stream.suspend(() => {
    let checkpoint = afterSeq;

    const connection = Stream.unwrap(
      Effect.gen(function* connect() {
        if (fence.did !== config.identity.did) {
          return yield* new MailboxClientError({
            reason: "Watch fence DID differs from recipient",
          });
        }

        const params = yield* Schema.decodeUnknownEffect(
          Schema.toType(Subscribe.Params)
        )({
          generation: fence.generation,
          leaseId: fence.leaseId,
          recipientDid: config.identity.did,
        }).pipe(Effect.mapError(clientError));

        const url = new URL(Subscribe.Method.path, config.endpoint);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

        for (const [name, value] of yield* Subscribe.encodeParams(params).pipe(
          Effect.mapError(clientError)
        )) {
          url.searchParams.set(name, value);
        }

        const port = yield* Effect.serviceOption(WebSocketPort);

        const socket = yield* Socket.fromWebSocket(
          Effect.acquireRelease(
            Effect.try({
              catch: (cause) =>
                new Socket.SocketError({
                  reason: new Socket.SocketOpenError({
                    cause,
                    kind: "Unknown",
                  }),
                }),
              try: () =>
                Option.isSome(port)
                  ? port.value.connect(url.href)
                  : new globalThis.WebSocket(url.href),
            }),
            (ws) =>
              Effect.sync(() => {
                ws.close(1000);
              })
          ),
          { highWaterMark: 65_536 }
        );

        const reader = yield* socket.reader.pipe(Effect.mapError(socketError));
        const writer = yield* socket.writer;
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

        const token = yield* serviceToken(
          {
            aud: config.serviceDid.replace(/(?:#mailbox)?$/u, "#mailbox"),
            exp: now + 60,
            iat: now,
            iss: config.identity.did,
            jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
            lxm: Subscribe.Method.nsid,
          },
          yield* importSigning(config.identity).pipe(
            Effect.mapError(clientError)
          )
        ).pipe(Effect.mapError(clientError));

        const auth = yield* Schema.encodeEffect(Subscribe.Auth)({
          $type: "sh.mschf.ratking.mailbox.subscribe#auth",
          token,
        }).pipe(Effect.mapError(clientError));

        yield* writer
          .write(JSON.stringify(auth))
          .pipe(Effect.mapError(socketError));

        const receiveNotice = Effect.gen(function* receiveNotice() {
          const frames = yield* reader.pull.pipe(Effect.mapError(socketError));

          for (const frame of frames) {
            yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Subscribe.Notice)
            )(
              Schema.is(Schema.String)(frame)
                ? frame
                : new TextDecoder().decode(frame)
            ).pipe(Effect.mapError(clientError));
          }
        });

        yield* receiveNotice;

        const notices = Stream.fromEffectRepeat(
          receiveNotice.pipe(Effect.flatMap(() => poll(checkpoint)))
        );

        return Stream.fromEffect(Effect.suspend(() => poll(checkpoint))).pipe(
          Stream.concat(notices)
        );
      })
    );

    return connection.pipe(
      Stream.filter((batch) => batch.events.length > 0),
      Stream.tap((batch) =>
        Effect.sync(() => {
          checkpoint = batch.throughSeq;
        })
      ),
      Stream.retry(
        Schedule.exponential("100 millis").pipe(
          Schedule.jittered,
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Math.min(5000, Duration.toMillis(duration)))
          ),
          Schedule.while(
            ({ input }: { readonly input: MailboxClientError }) =>
              input.error === "SocketDisconnected"
          )
        )
      )
    );
  });
