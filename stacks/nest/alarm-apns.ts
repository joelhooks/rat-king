import { connect } from "node:http2";

import { Clock, Effect, Option, Schema } from "effect";

import { cryptoOperation } from "../../packages/envelope/src/webcrypto.ts";
import type * as Push from "../../packages/lexicon/src/device.pendingPush.ts";
import {
  base64url,
  unbase64url,
} from "../../packages/mailbox-client/src/auth.ts";

const Credential = Schema.fromJsonString(
  Schema.Struct({
    bundleId: Schema.NonEmptyString.check(
      Schema.isPattern(/^[a-zA-Z0-9.-]+$/u)
    ),
    keyId: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Z0-9]{10}$/u)),
    privateKey: Schema.NonEmptyString,
    teamId: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Z0-9]{10}$/u)),
  })
);

export type SendPush = (notice: Push.NoticeValue) => Effect.Effect<boolean>;

const part = (value: string) => base64url(new TextEncoder().encode(value));

const request = (notice: Push.NoticeValue, token: string, topic: string) =>
  Effect.callback<boolean>((resume) => {
    const host =
      notice.environment === "sandbox"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";

    const client = connect(host);

    const finish = (sent: boolean) => {
      client.destroy();
      resume(Effect.succeed(sent));
    };

    const fail = () => {
      finish(false);
    };

    client.once("error", fail);

    const stream = client.request({
      ":method": "POST",
      ":path": `/3/device/${notice.token}`,
      "apns-expiration": "0",
      "apns-priority": "10",
      "apns-push-type": "alert",
      "apns-topic": topic,
      authorization: `bearer ${token}`,
      "content-type": "application/json",
    });

    stream.once("error", fail);
    stream.once("end", fail);
    stream.once("response", (headers) => {
      finish(headers[":status"] === 200);
    });
    stream.resume();
    stream.end(
      JSON.stringify({
        admissionSeq: notice.admissionSeq,
        aps: { alert: { body: notice.body, title: notice.title } },
        messageId: notice.messageId,
      })
    );

    return Effect.sync(() => {
      client.destroy();
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.succeed(false),
    })
  );

const importKey = (pem: string) =>
  Effect.try(() =>
    unbase64url(
      pem
        .replaceAll(/-{5}(?:BEGIN|END) PRIVATE KEY-{5}/gu, "")
        .replaceAll(/\s/gu, "")
    )
  ).pipe(
    Effect.flatMap((bytes) =>
      cryptoOperation(
        crypto.subtle.importKey.bind(
          crypto.subtle,
          "pkcs8",
          bytes,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign"]
        )
      )
    ),
    Effect.option
  );

export const apnsSender = Effect.fn("Alarm.apnsSender")(function* apnsSender(
  raw: string
) {
  const config = Option.getOrUndefined(Schema.decodeOption(Credential)(raw));

  if (config === undefined) {
    return null;
  }

  const key = yield* importKey(config.privateKey);

  if (Option.isNone(key)) {
    return null;
  }

  const header = part(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  let cached: { at: number; token: string } | undefined;

  const send: SendPush = Effect.fn("Alarm.sendApns")(
    function* sendApns(notice: Push.NoticeValue) {
      const now = yield* Clock.currentTimeMillis;

      if (
        cached === undefined ||
        now < cached.at ||
        now - cached.at >= 45 * 60_000
      ) {
        const claims = part(
          JSON.stringify({ iat: Math.floor(now / 1000), iss: config.teamId })
        );

        const unsigned = `${header}.${claims}`;

        const signature = yield* cryptoOperation(
          crypto.subtle.sign.bind(
            crypto.subtle,
            { hash: "SHA-256", name: "ECDSA" },
            key.value,
            new TextEncoder().encode(unsigned)
          )
        );

        cached = {
          at: now,
          token: `${unsigned}.${base64url(new Uint8Array(signature))}`,
        };
      }

      return yield* request(notice, cached.token, config.bundleId);
    },
    (effect) => effect.pipe(Effect.catchCause(() => Effect.succeed(false)))
  );

  return send;
});
