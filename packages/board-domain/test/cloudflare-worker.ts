/* oxlint-disable eslint/max-classes-per-file -- The local test Worker serves its test-only Domain API. */
import {
  Worker,
  WorkerEnvironment,
} from "@alchemy.run/cloudflare/Workers/Worker";
import { Api } from "@alchemy.run/domain";
import { layerDurableObjects } from "@alchemy.run/domain/Cloudflare";
import { Context, Effect, Layer, Schema } from "effect";
import { SecureRandom, layerWebCrypto } from "effect/crypto/SecureRandom";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";

import { Board, boardPolicies, Channel, Task } from "../src/board.ts";
import { channel, taskId } from "./fixtures.ts";

export class BoardProofApi extends Api("BoardProofApi", {
  commands: [
    "OpenChannel",
    "PostMessage",
    "CreateTask",
    "ClaimTask",
    "CompleteTask",
    "RenewClaim",
  ],
  model: Board,
  views: ["TaskView", "ThreadView"],
}) {}

export const BoardProofRevision = Context.Reference("BoardProofRevision", {
  defaultValue: () => "1",
});

const live = Board.layer(boardPolicies).pipe(
  Layer.provide(layerDurableObjects())
);

export default class BoardProofWorker extends Worker<BoardProofWorker>()(
  "BoardProofWorker",
  BoardProofRevision.pipe(
    Effect.map((revision) => ({
      env: { BOARD_PROOF_REVISION: revision },
      main: import.meta.url,
    }))
  ),
  Effect.gen(function* startProof() {
    const api = yield* BoardProofApi;
    const channels = yield* Channel;
    const tasks = yield* Task;
    const random = yield* SecureRandom;
    const isolate = yield* random.uuidV4();

    return {
      fetch: Effect.gen(function* fetch() {
        const request = yield* HttpServerRequest;

        if (
          new URL(request.url, "http://example.invalid").pathname === "/inspect"
        ) {
          const env = yield* WorkerEnvironment;

          const revision = yield* Schema.decodeUnknownEffect(Schema.String)(
            env.BOARD_PROOF_REVISION
          ).pipe(Effect.orDie);

          return yield* Response.json({
            channel: yield* channels.get(channel),
            isolate,
            revision,
            task: (yield* tasks.get(taskId)).task,
          });
        }

        return yield* api.fetch;
      }),
    };
  }).pipe(Effect.provide(Layer.merge(live, layerWebCrypto)))
) {}
