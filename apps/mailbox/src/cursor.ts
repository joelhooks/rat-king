/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import { canonical, canonicalDecode } from "@rat-king/envelope/canonical";
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Effect, Schema } from "effect";

import { base64url, unbase64url } from "./auth.ts";
import { failure } from "./failure.ts";

export const Cursor = Schema.Struct({
  fingerprint: Schema.String,
  lastSeq: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  ),
  recipient: Schema.String,
  throughSeq: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  ),
  version: Schema.Int,
});

export type CursorValue = typeof Cursor.Type;

const hmacKey = (secret: Uint8Array) =>
  cryptoOperation(() =>
    crypto.subtle.importKey(
      "raw",
      new Uint8Array(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign", "verify"]
    )
  );

export const encodeCursor = Effect.fn("Mailbox.encodeCursor")(
  function* encodeCursor(cursor: CursorValue, secret: Uint8Array) {
    const key = yield* hmacKey(secret);
    const bytes = canonical(cursor);

    const signature = yield* cryptoOperation(() =>
      crypto.subtle.sign("HMAC", key, new Uint8Array(bytes))
    );

    return `${base64url(bytes)}.${base64url(new Uint8Array(signature))}`;
  }
);

export interface CursorRequest {
  readonly token: string;
  readonly secret: Uint8Array;
  readonly recipient: string;
  readonly fingerprint: string;
  readonly afterSeq: number;
  readonly watermark: number;
}

export const decodeCursor = Effect.fn("Mailbox.decodeCursor")(
  function* decodeCursor(request: CursorRequest) {
    const [payload = "", signature = "", extra] = request.token.split(".");

    if (!payload || !signature || extra !== undefined) {
      return yield* Effect.fail(failure("InvalidCursor"));
    }

    const bytes = yield* Effect.try({
      catch: () => failure("InvalidCursor"),
      try: () => ({
        payload: unbase64url(payload),
        signature: unbase64url(signature),
      }),
    });

    const key = yield* hmacKey(request.secret);

    const valid = yield* cryptoOperation(() =>
      crypto.subtle.verify(
        "HMAC",
        key,
        new Uint8Array(bytes.signature),
        new Uint8Array(bytes.payload)
      )
    );

    if (!valid) {
      return yield* Effect.fail(
        failure("InvalidCursor", 400, "Bad cursor authentication")
      );
    }

    const cursor = yield* Schema.decodeUnknownEffect(Cursor)(
      yield* canonicalDecode(bytes.payload)
    ).pipe(Effect.mapError(() => failure("InvalidCursor")));

    if (cursor.version !== 1) {
      return yield* Effect.fail(
        failure("InvalidCursor", 400, "Unknown cursor version")
      );
    }

    if (cursor.recipient !== request.recipient) {
      return yield* Effect.fail(
        failure("InvalidCursor", 400, "Cursor recipient mismatch")
      );
    }

    if (cursor.fingerprint !== request.fingerprint) {
      return yield* Effect.fail(
        failure("InvalidCursor", 400, "Cursor query fingerprint mismatch")
      );
    }

    if (
      cursor.throughSeq > request.watermark ||
      cursor.lastSeq > cursor.throughSeq ||
      cursor.lastSeq < request.afterSeq ||
      cursor.throughSeq < request.afterSeq
    ) {
      return yield* Effect.fail(
        failure("InvalidCursor", 400, "Cursor position outside snapshot")
      );
    }

    return cursor;
  },
  Effect.mapError((error) =>
    Schema.is(XrpcFailure)(error) ? error : failure("InvalidCursor")
  )
);
