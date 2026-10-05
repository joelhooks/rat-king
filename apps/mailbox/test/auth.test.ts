import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";

import {
  testKeys,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import {
  authenticate,
  ReplayAuthority,
  serviceToken,
  staticResolver,
} from "../src/auth.ts";
import { failure } from "../src/failure.ts";
import { documents } from "./helpers.ts";

it.effect(
  "ES256 service auth validates every claim and rejects reuse, bad key and missing auth",
  () =>
    Effect.gen(function* verifyContract() {
      const keys = yield* testKeys();

      const docs = yield* documents(
        keys.sender.publicKey,
        keys.recipient.publicKey
      );

      const used = yield* Ref.make(new Set<string>());

      const replay = Layer.succeed(ReplayAuthority, {
        consume: (claims) =>
          Ref.modify(used, (tokens) => [
            tokens.has(claims.jti),
            new Set([...tokens, claims.jti]),
          ]).pipe(
            Effect.flatMap((reused) =>
              reused ? Effect.fail(failure("AuthRequired", 401)) : Effect.void
            )
          ),
      });

      const claims = {
        aud: "did:web:service.example#mailbox",
        exp: 160,
        iat: 100,
        iss: senderDid,
        jti: "unique-test-token-0001",
        lxm: "sh.mschf.ratking.mailbox.send",
      };

      const run = (authorization: string | null) =>
        authenticate({
          audience: claims.aud,
          authorization,
          now: 100_000,
          nsid: claims.lxm,
        }).pipe(Effect.provide(Layer.merge(staticResolver(docs), replay)));

      const token = yield* serviceToken(claims, keys.sender.privateKey);
      expect(yield* run(`Bearer ${token}`)).toBe(senderDid);
      expect((yield* run(`Bearer ${token}`).pipe(Effect.exit))._tag).toBe(
        "Failure"
      );

      for (const altered of [
        { ...claims, iss: "did:web:wrong.example" },
        { ...claims, aud: "did:web:service.example" },
        { ...claims, exp: 100 },
        { ...claims, exp: 161 },
        { ...claims, iat: 101 },
        { ...claims, iat: 1 },
        { ...claims, jti: "" },
        { ...claims, lxm: "sh.mschf.ratking.mailbox.ack" },
      ]) {
        const bad = yield* serviceToken(altered, keys.sender.privateKey);
        expect((yield* run(`Bearer ${bad}`).pipe(Effect.exit))._tag).toBe(
          "Failure"
        );
      }

      const other = yield* testKeys();
      expect(
        (yield* run(
          `Bearer ${yield* serviceToken({ ...claims, jti: "unique-test-token-0002" }, other.sender.privateKey)}`
        ).pipe(Effect.exit))._tag
      ).toBe("Failure");
      expect((yield* run(null).pipe(Effect.exit))._tag).toBe("Failure");
      expect((yield* run("Bearer not-a-jwt").pipe(Effect.exit))._tag).toBe(
        "Failure"
      );
      expect(
        (yield* run(
          `Bearer ${yield* serviceToken({ ...claims, jti: "unique-test-token-0003" }, keys.sender.privateKey, "#unknown")}`
        ).pipe(Effect.exit))._tag
      ).toBe("Failure");
    })
);
