import { providers as cloudflareProviders } from "@alchemy.run/cloudflare";
import { providers as domainProviders } from "@alchemy.run/domain/Cloudflare";
import { isCaughtUp } from "@alchemy.run/domain/Read";
import { resolveDev } from "@alchemy.run/test/Core";
import * as Test from "@alchemy.run/test/Vitest";
import { Effect, Layer, Schedule, Schema, Stream } from "effect";
import { uuidV4Unsafe } from "effect/crypto/SecureRandom";
import { FetchHttpClient, HttpClient } from "effect/http";
import { assert, expect } from "vitest";

import { ClaimLost, Message, TaskSnapshot, threadKey } from "../src/board.ts";
import {
  objectDatabaseExists,
  taskAlarmPersisted,
} from "./cloudflare-sqlite.ts";
import BoardProofWorker, {
  BoardProofApi,
  BoardProofRevision,
} from "./cloudflare-worker.ts";
import {
  channel,
  owner,
  ownerDigest,
  taskFields,
  taskId,
  taskThread,
} from "./fixtures.ts";

if (!resolveDev({ dev: true })) {
  throw new Error("Board proof requires local Alchemy dev mode");
}

const directory = `.alchemy/board-proof-${uuidV4Unsafe()}`;

const { test } = Test.make({
  dev: true,
  dotAlchemy: directory,
  providers: Layer.merge(cloudflareProviders(), domainProviders()),
  sidecar: false,
});

const Snapshot = Schema.Struct({
  channel: Schema.Struct({ messages: Schema.Array(Message) }),
  isolate: Schema.String,
  revision: Schema.String,
  task: TaskSnapshot,
});

const inspect = (url: string) =>
  HttpClient.get(`${url}/inspect`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Snapshot))
  );

interface WorkerLocation {
  readonly workerId: string;
  readonly url: string | undefined;
}

const localUrl = (worker: WorkerLocation) => {
  if (!worker.workerId.startsWith("dev:") || worker.url === undefined) {
    return Effect.die("Expected a local workerd instance");
  }

  const { port, protocol } = new URL(worker.url);

  if (protocol !== "http:" || port === "") {
    return Effect.die("Expected a dedicated local HTTP port");
  }

  return Effect.succeed(`http://127.0.0.1:${port}`);
};

const prepare = (revision: string) =>
  Effect.gen(function* prepareRevision() {
    return {
      worker: yield* BoardProofWorker.pipe(
        Effect.provideService(BoardProofRevision, revision)
      ),
    };
  });

const alarmProbe = Schedule.spaced("100 millis");

test.provider(
  "local workerd restarts with Board SQLite state and a pending lease alarm, then folds to CaughtUp",
  (stack) =>
    Effect.gen(function* proveBoardOnWorkerd() {
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Alchemy's scratch adapter erases provider errors; fail the test on any defect.
      const first = yield* stack.deploy(prepare("1")).pipe(Effect.orDie);
      const firstUrl = yield* localUrl(first.worker);
      const api = yield* BoardProofApi.clientHttp(firstUrl);
      yield* api.OpenChannel(channel, { owner });

      const post = yield* api.PostMessage(channel, {
        actor: owner,
        body: "survives restart",
        message: taskThread,
      });

      expect(post).toMatchObject({ stream: `Channel/${channel}`, version: 2 });
      const created = yield* api.CreateTask(taskId, taskFields());
      expect(created).toMatchObject({ stream: `Task/${taskId}`, version: 1 });

      const claimed = yield* api.ClaimTask(taskId, {
        actor: owner,
        digest: ownerDigest,
        leaseMillis: 30_000,
      });

      const { claim } = claimed.reply;

      assert(claim !== null, "Claim did not commit");

      expect(
        yield* objectDatabaseExists(directory, "Board.ChannelAggregate")
      ).toBe(true);

      const armed = yield* taskAlarmPersisted(directory, claim.until).pipe(
        Effect.repeat({
          schedule: alarmProbe,
          times: 100,
          until: (present) => present,
        })
      );

      expect(armed).toBe(true);
      const firstSnapshot = yield* inspect(firstUrl);

      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Alchemy's scratch adapter erases provider errors; fail the test on any defect.
      const second = yield* stack.deploy(prepare("2")).pipe(Effect.orDie);
      const secondUrl = yield* localUrl(second.worker);
      const secondSnapshot = yield* inspect(secondUrl);
      expect([firstSnapshot.revision, secondSnapshot.revision]).toStrictEqual([
        "1",
        "2",
      ]);
      expect(secondSnapshot.isolate).not.toBe(firstSnapshot.isolate);
      expect(secondSnapshot.channel.messages).toMatchObject([
        { body: "survives restart", message: taskThread },
      ]);
      expect(secondSnapshot.task).toEqual(firstSnapshot.task);
      expect(secondSnapshot.task?.phase._tag).toBe("claimed");

      const restarted = yield* BoardProofApi.clientHttp(secondUrl);

      const expired = yield* restarted.TaskView.get(taskId, {
        atLeast: claimed,
      }).pipe(
        Effect.repeat({
          schedule: alarmProbe,
          times: 400,
          until: (task) => task?.epoch === claim.epoch + 1,
        })
      );

      expect(expired?.phase._tag).toBe("ready");
      expect(expired?.epoch).toBe(claim.epoch + 1);

      const rejected = yield* restarted
        .CompleteTask(taskId, {
          actor: owner,
          digest: ownerDigest,
          epoch: claim.epoch,
          result: "stale",
        })
        .pipe(Effect.flip);

      expect(rejected).toEqual(new ClaimLost({ reason: "StaleEpoch" }));

      const thread = yield* restarted.ThreadView.get(
        threadKey(channel, taskThread),
        { atLeast: post }
      ).pipe(
        Effect.repeat({
          schedule: alarmProbe,
          times: 50,
          until: (state) => state?.taskLabel?.value === "ready",
        })
      );

      expect(thread?.taskLabel).toStrictEqual({
        key: "board.task",
        value: "ready",
      });

      const frames = yield* restarted.TaskView.events(taskId).pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.timeout("5 seconds")
      );

      expect(
        frames.map((frame) =>
          isCaughtUp(frame) ? frame._tag : frame.event.transition
        )
      ).toStrictEqual([
        "TaskCreated",
        "TaskClaimed",
        "ClaimExpired",
        "CaughtUp",
      ]);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 90_000 }
);
