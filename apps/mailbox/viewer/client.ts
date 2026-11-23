/* oxlint-disable typescript/promise-function-async -- Effect owns lazy WebCrypto operations. */
import * as History from "@rat-king/lexicon/mailbox.listTraffic";
import * as Tail from "@rat-king/lexicon/mailbox.subscribeTraffic";
import { base64url, serviceToken } from "@rat-king/mailbox-client/auth";
import { Clock, Effect, Schema, Stream } from "effect";
import { Socket } from "effect/socket";

export class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()("TrafficUnavailable", {}) {}

export interface TrafficSource {
  readonly list: (
    cursor: number
  ) => Effect.Effect<History.OutputValue, Unavailable>;
  readonly notices: Stream.Stream<number, Unavailable>;
}

interface Observer {
  readonly endpoint: URL;
  readonly did: string;
  readonly audience: string;
  readonly key: CryptoKey;
}

const token = Effect.fn("TrafficViewer.serviceToken")(function* token(
  observer: Observer,
  method: typeof History.Method | typeof Tail.Method
) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

  const nonce = yield* Effect.sync(() =>
    base64url(crypto.getRandomValues(new Uint8Array(16)))
  );

  return yield* serviceToken(
    {
      aud: observer.audience,
      exp: now + 60,
      iat: now,
      iss: observer.did,
      jti: nonce,
      lxm: method.nsid,
    },
    observer.key
  );
});

const Notice = Schema.fromJsonString(
  Schema.Struct({
    $type: Schema.Literal(`${Tail.Method.nsid}#notice`),
    seq: Tail.Notice.schema.fields.seq,
  })
);

interface Platform {
  readonly fetch: (url: URL, init: RequestInit) => Promise<Response>;
  readonly connect: (url: string) => Socket.WebSocketLike;
}

export const trafficSource = (
  observer: Observer,
  platform: Platform
): TrafficSource => {
  const list = Effect.fn("TrafficViewer.list")(
    function* list(cursor: number) {
      const url = new URL(History.Method.path, observer.endpoint);

      for (const [name, value] of yield* History.encodeParams({
        cursor: String(cursor),
        limit: 100,
      })) {
        url.searchParams.set(name, value);
      }

      const authorization = `Bearer ${yield* token(observer, History.Method)}`;

      const response = yield* Effect.tryPromise((signal) =>
        platform.fetch(url, {
          headers: { authorization },
          method: History.Method.method,
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        })
      );

      if (!response.ok) {
        yield* Effect.tryPromise(
          () => response.body?.cancel() ?? Promise.resolve()
        );

        return yield* new Unavailable();
      }

      const body = yield* Effect.tryPromise(() => response.text());

      return yield* Schema.decodeEffect(Schema.fromJsonString(History.Output))(
        body
      );
    },
    (effect) =>
      effect.pipe(
        Effect.timeout("8 seconds"),
        Effect.mapError(() => new Unavailable())
      )
  );

  const notices = Stream.unwrap(
    Effect.gen(function* subscribe() {
      const url = new URL(Tail.Method.path, observer.endpoint);
      url.protocol = "wss:";

      const socket = yield* Socket.fromWebSocket(
        Effect.acquireRelease(
          Effect.sync(() => platform.connect(url.href)),
          (ws) =>
            Effect.sync(() => {
              ws.close(1000);
            })
        )
      );

      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const auth = yield* token(observer, Tail.Method);
      yield* writer.write(
        JSON.stringify({ $type: `${Tail.Method.nsid}#auth`, token: auth })
      );

      return Stream.fromEffectRepeat(
        reader.pull.pipe(Effect.timeout("70 seconds"))
      ).pipe(
        Stream.flatMap(Stream.fromIterable),
        Stream.mapEffect((frame) =>
          Schema.decodeEffect(Notice)(
            Schema.is(Schema.String)(frame)
              ? frame
              : new TextDecoder().decode(frame)
          )
        ),
        Stream.map(({ seq }) => seq)
      );
    })
  ).pipe(Stream.mapError(() => new Unavailable()));

  return { list, notices };
};
