import { it } from "@effect/vitest";
import { Effect, Layer, Logger, Schema } from "effect";
import { CurrentLogAnnotations } from "effect/References";
import { expect } from "vitest";

import { importSigning } from "../../../packages/mailbox-client/src/identity.ts";
import { ReplayAuthority } from "../../../packages/mailbox-client/src/replay.ts";
import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";
import {
  authenticateClaims,
  serviceToken,
  staticResolver,
} from "../src/auth.ts";
import { respondToFailure } from "../src/failure-log.ts";
import { failure } from "../src/failure.ts";

it.effect.prop(
  "mailbox allows five seconds of forward skew and logs claims failures without changing wire bytes",
  [Schema.Int.check(Schema.isBetween({ maximum: 1_000_000, minimum: 100 }))],
  ([now]) =>
    Effect.gen(function* wireProof() {
      const sender = yield* identity("did:web:sender.invalid");
      const other = yield* identity(sender.did);
      const key = yield* importSigning(sender);
      const wrongKey = yield* importSigning(other);
      const used = new Set<string>();

      const services = Layer.merge(
        staticResolver([yield* document(sender)]),
        Layer.succeed(ReplayAuthority, {
          consume: (claims) =>
            Effect.suspend(() => {
              if (used.has(claims.jti)) {
                return Effect.fail(
                  failure("AuthRequired", 401, "Reused service token")
                );
              }

              used.add(claims.jti);

              return Effect.void;
            }),
        })
      );

      const claims = {
        aud: "did:web:mailbox.invalid#mailbox",
        exp: now + 60,
        iat: now,
        iss: sender.did,
        jti: "wire-auth-valid-token-0001",
        lxm: "sh.mschf.ratking.mailbox.send",
      };

      const warnings: unknown[] = [];

      const capture = Logger.make(({ fiber, logLevel, message }) => {
        warnings.push({
          fields: fiber.getRef(CurrentLogAnnotations),
          level: logLevel,
          message,
        });
      });

      const run = (authorization: string | null) =>
        authenticateClaims({
          audience: claims.aud,
          authorization,
          now: now * 1000,
          nsid: claims.lxm,
        }).pipe(
          Effect.provide(services),
          Effect.catchTag("XrpcFailure", (refusal) =>
            Effect.gen(function* renderFailure() {
              const response = yield* respondToFailure(
                { method: claims.lxm },
                refusal
              );

              return {
                body: yield* Effect.promise(response.text.bind(response)),
                status: response.status,
              };
            })
          ),
          Effect.provide(Logger.layer([capture]))
        );

      const valid = yield* serviceToken(claims, key);
      expect(yield* run(`Bearer ${valid}`)).toEqual(claims);

      const bad = yield* serviceToken(
        { ...claims, jti: "wire-auth-wrong-key-0002" },
        wrongKey
      );

      for (const [authorization, body] of [
        [null, '{"error":"AuthRequired","message":"AuthRequired"}'],
        [`Bearer ${bad}`, '{"error":"AuthRequired","message":"AuthRequired"}'],
        [
          `Bearer ${valid}`,
          '{"error":"AuthRequired","message":"Reused service token"}',
        ],
      ] as const) {
        expect(yield* run(authorization)).toEqual({ body, status: 401 });
      }

      for (const ahead of [3, 5]) {
        const adjusted = {
          ...claims,
          exp: now + ahead + 60,
          iat: now + ahead,
          jti: `wire-auth-ahead-${ahead}-seconds`,
        };

        expect(
          yield* run(`Bearer ${yield* serviceToken(adjusted, key)}`)
        ).toEqual(adjusted);
      }

      for (const [check, overrides] of [
        ["aud", { aud: "did:web:other.invalid#mailbox" }],
        ["lxm", { lxm: "sh.mschf.ratking.mailbox.ack" }],
        ["iat-future", { exp: now + 66, iat: now + 6 }],
        ["expired", { exp: now, iat: now - 60 }],
        ["exp-before-iat", { exp: now + 3, iat: now + 3 }],
        ["lifetime", { exp: now + 64, iat: now + 3 }],
        ["stale", { exp: now + 1, iat: now - 61 }],
      ] as const) {
        warnings.length = 0;

        const tokenWithUnverifiedIssuer = yield* serviceToken(
          { ...claims, ...overrides },
          wrongKey
        );

        expect(yield* run(`Bearer ${tokenWithUnverifiedIssuer}`)).toEqual({
          body: '{"error":"AuthRequired","message":"Invalid service-auth claims"}',
          status: 401,
        });
        expect(warnings).toEqual([
          {
            fields: {
              check,
              claimedIssuer: sender.did,
              detail: "Invalid service-auth claims",
              error: "AuthRequired",
              method: claims.lxm,
              status: 401,
            },
            level: "Warn",
            message: ["Mailbox XRPC failure"],
          },
        ]);
      }

      warnings.length = 0;

      const nonDid = yield* serviceToken(
        { ...claims, exp: now, iss: "arbitrary untrusted text" },
        key
      );

      yield* run(`Bearer ${nonDid}`);
      expect(warnings).toEqual([
        {
          fields: {
            check: "expired",
            detail: "Invalid service-auth claims",
            error: "AuthRequired",
            method: claims.lxm,
            status: 401,
          },
          level: "Warn",
          message: ["Mailbox XRPC failure"],
        },
      ]);
    })
);
