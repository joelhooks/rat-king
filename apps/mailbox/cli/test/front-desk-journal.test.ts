import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { sealed } from "../../../../packages/envelope/test/helpers.ts";
import {
  frontDeskJournalHealth,
  withFrontDeskJournal,
} from "../../../../stacks/nest/front-desk-journal.ts";
import { fixtureChild } from "./fixture-child.ts";

const configured = (seconds?: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      RAT_KING_FRONT_DESK_REDELIVERY_SECONDS: seconds,
    })
  );

it.effect(
  "pruning is off by default and an explicit redelivery window removes only completed old non-current rows",
  () =>
    Effect.gen(function* verify() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const { envelope } = yield* sealed();
      const { messageId } = envelope.aad;

      const complete = (id: string) =>
        withFrontDeskJournal(directory, id, ({ sign, write }) =>
          Effect.gen(function* done() {
            const hash = yield* sign(id);

            return yield* write({
              completedAt: 0,
              hash,
              messageId,
              step: "done",
            });
          })
        ).pipe(Effect.provide(configured()));

      yield* complete("old");
      yield* complete("current");
      yield* withFrontDeskJournal(directory, "pending", ({ sign, write }) =>
        Effect.gen(function* pending() {
          const hash = yield* sign("pending");

          return yield* write({
            copy: envelope,
            hash,
            primary: envelope,
            step: "prepared",
          });
        })
      ).pipe(Effect.provide(configured()));

      const touch = (seconds?: string) =>
        withFrontDeskJournal(directory, "current", ({ read }) => read).pipe(
          Effect.provide(configured(seconds))
        );

      yield* TestClock.setTime(60_000);
      yield* touch("60");
      expect((yield* frontDeskJournalHealth(directory)).rows).toBe(3);

      yield* TestClock.setTime(60_001);
      yield* touch();
      expect((yield* frontDeskJournalHealth(directory)).rows).toBe(3);

      const retained = yield* touch("60");

      const pending = yield* withFrontDeskJournal(
        directory,
        "pending",
        ({ read }) => read
      ).pipe(Effect.provide(configured()));

      expect(retained?.step).toBe("done");
      expect(pending?.step).toBe("prepared");
      expect((yield* frontDeskJournalHealth(directory)).rows).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const lockProbe = `
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { withFrontDeskJournal } from "./stacks/nest/front-desk-journal.ts";
NodeRuntime.runMain(withFrontDeskJournal(process.env.HOME, "fixture", ({ read, sign, write }) => Effect.gen(function* () {
  if ((yield* read) !== null) return yield* Console.log("replayed");
  yield* Effect.sleep("100 millis");
  const hash = yield* sign("fixture");
  yield* write({ completedAt: 0, hash, messageId: "2222222222222", step: "done" });
  return yield* Console.log("created");
})).pipe(Effect.provide(NodeServices.layer)));
`;

it.effect(
  "separate signer processes contend on the same durable row lock",
  () =>
    Effect.gen(function* verify() {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();

      const run = fixtureChild(
        ["--input-type=module", "--eval", lockProbe],
        home
      );

      const children = yield* Effect.all([run, run], {
        concurrency: "unbounded",
      });

      expect(children.map(({ code }) => code)).toEqual([0, 0]);
      expect(children.map(({ stdout }) => stdout.trim()).toSorted()).toEqual([
        "created",
        "replayed",
      ]);

      const config = `${home}/relay.json`;
      yield* fs.writeFileString(
        config,
        JSON.stringify({
          didTemplate: "did:web:{agent}.example.invalid",
          endpoint: "https://mailbox.example.invalid",
          serviceDid: "did:web:mailbox.example.invalid",
          state: home,
        })
      );

      const health = yield* fixtureChild(
        ["stacks/nest/cli.ts", "ops-health", "--service", "front-desk"],
        home,
        {
          RATKING_CONFIG: config,
          RAT_KING_SECRET_SOURCE: "systemd",
        }
      );

      expect(health.code, health.stderr).toBe(0);

      const receipt = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Unknown)
      )(health.stdout);

      const journal = yield* frontDeskJournalHealth(home);

      expect(receipt).toEqual({
        bytes: journal.bytes,
        keyLossReview: false,
        rows: 1,
        service: "front-desk",
        status: "ok",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
