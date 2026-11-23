/* oxlint-disable eslint/no-redeclare -- ClaimToken is a Schema and its inferred redacted type. */
import { Effect, Redacted, Schema } from "effect";
import { Digest, sha256 } from "effect/crypto/Digest";
import { SecureRandom } from "effect/crypto/SecureRandom";

import { ClaimDigest } from "./records.ts";
import type { Did, TaskId } from "./records.ts";
import { ClaimTask, Task } from "./task.ts";

const Token = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)
);

export const ClaimToken = Schema.RedactedFromValue(Token);

export type ClaimToken = typeof ClaimToken.Type;

export const claimDigest = Effect.fn("Board.claimDigest")(function* hashToken(
  token: ClaimToken
) {
  const digest = yield* Digest;

  const hex = yield* digest.digestHex(
    sha256,
    new TextEncoder().encode(Redacted.value(token))
  );

  return ClaimDigest.make(hex);
});

interface ClaimRequest {
  readonly actor: Did;
  readonly taskId: TaskId;
  readonly leaseMillis: number;
  readonly token?: ClaimToken;
}

const freshToken = Effect.gen(function* generateToken() {
  const random = yield* SecureRandom;
  const bytes = yield* random.randomBytes(32);

  const encoded = yield* Schema.encodeEffect(Schema.Uint8ArrayFromBase64Url)(
    bytes
  ).pipe(Effect.orDie);

  return Redacted.make(Token.make(encoded));
});

export const claimTask = Effect.fn("Board.claimTask")(function* claimTask(
  request: ClaimRequest
) {
  const tasks = yield* Task;
  const token = request.token ?? (yield* freshToken);
  const digest = yield* claimDigest(token);

  const receipt = yield* tasks.send(
    request.taskId,
    new ClaimTask({
      actor: request.actor,
      digest,
      leaseMillis: request.leaseMillis,
    })
  );

  if (receipt.reply.claim === null) {
    return yield* Effect.die("Accepted ClaimTask did not return a claim");
  }

  return { claim: receipt.reply.claim, token, version: receipt.version };
});

interface LeaseCredential {
  readonly actor: Did;
  readonly epoch: number;
  readonly token: ClaimToken;
}

export const claimFence = Effect.fn("Board.claimFence")(function* claimFence({
  actor,
  epoch,
  token,
}: LeaseCredential) {
  return { actor, digest: yield* claimDigest(token), epoch };
});
