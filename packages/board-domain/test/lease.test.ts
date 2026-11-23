import { InMemory } from "@alchemy.run/domain";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Schema } from "effect";
import { layerWebCrypto as digestLayer } from "effect/crypto/Digest";
import { layerWebCrypto as randomLayer } from "effect/crypto/SecureRandom";
import { expect } from "vitest";

import {
  Board,
  boardPolicies,
  claimDigest,
  claimFence,
  ClaimLost,
  claimTask,
  ClaimToken,
  CompleteTask,
  LeaseMillis,
  Task,
} from "../src/board.ts";
import { create, owner, taskId } from "./fixtures.ts";

const memory = Board.layer(boardPolicies).pipe(Layer.provide(InMemory));

const cryptoLayer = Layer.merge(digestLayer, randomLayer);

const tokenWith = (digit: number) =>
  Schema.decodeSync(ClaimToken)(`${String(digit).repeat(42)}A`);

it.effect.prop(
  "a lost claim response can be recovered without changing the epoch or appending an event",
  [Arbitrary.schema(LeaseMillis), Schema.Boolean],
  ([leaseMillis, supplied]) =>
    Effect.gen(function* recoverClaim() {
      const tasks = yield* Task;
      yield* tasks.send(taskId, create());

      const request = { actor: owner, leaseMillis, taskId };
      const knownToken = tokenWith(1);

      const original = yield* claimTask(
        supplied ? { ...request, token: knownToken } : request
      );

      const token = supplied ? knownToken : original.token;

      const retried = yield* claimTask({ ...request, token });

      expect(retried.claim).toStrictEqual(original.claim);
      expect(retried.version).toBe(original.version);

      const state = yield* tasks.get(taskId);
      expect(state.claimDigest).toBe(yield* claimDigest(token));

      const fence = yield* claimFence({
        actor: owner,
        epoch: retried.claim.epoch,
        token: tokenWith(2),
      });

      const refusal = yield* tasks
        .send(taskId, new CompleteTask({ ...fence, result: "wrong token" }))
        .pipe(Effect.flip);

      expect(refusal).toEqual(new ClaimLost({ reason: "CredentialMismatch" }));
    }).pipe(Effect.provide(Layer.merge(memory, cryptoLayer)))
);
