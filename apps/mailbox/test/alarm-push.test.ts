import { it } from "@effect/vitest";
import * as Push from "@rat-king/lexicon/device.pendingPush";
import { Console, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import type { PushAttemptsValue } from "../../../stacks/nest/alarm-push-state.ts";
import {
  dispatchPush,
  loadAlarmPush,
} from "../../../stacks/nest/alarm-push.ts";
import { CliError } from "../cli/identity.ts";
import { SecretStore } from "../cli/secrets.ts";

it.effect.prop(
  "the persisted attempt suppresses replays across restarts, and newer mail until the minute ends",
  {
    elapsed: Schema.Int.check(
      Schema.isBetween({ maximum: 120_000, minimum: 0 })
    ),
  },
  ({ elapsed }) =>
    Effect.gen(function* verify() {
      const sent: number[] = [];
      let state: PushAttemptsValue = {};

      const poll = (notice: Push.NoticeValue) =>
        dispatchPush(
          state,
          [{ name: "phone-fixture", notice }],
          (value) =>
            Effect.sync(() => {
              expect(state["phone-fixture"]?.messageId).toBe(value.messageId);
              sent.push(value.admissionSeq);

              return true;
            }),
          (next) =>
            Effect.sync(() => {
              state = next;
            })
        );

      const first = yield* Schema.decodeUnknownEffect(Push.Notice)({
        admissionSeq: 1,
        body: "New sealed message",
        environment: "sandbox",
        messageId: "2222222222222",
        title: "Rat King",
        token: "12",
      });

      const next = yield* Schema.decodeUnknownEffect(Push.Notice)({
        ...first,
        admissionSeq: 2,
        messageId: "2222222222223",
      });

      yield* poll(first);
      yield* TestClock.adjust(elapsed);
      yield* poll(first);
      yield* poll(next);

      expect(sent).toEqual(elapsed < 60_000 ? [1] : [1, 2]);
    })
);

it.effect.prop(
  "a missing APNs ref emits one generic health fact and leaves the sender off",
  [Schema.NonEmptyString],
  ([secret]) =>
    Effect.gen(function* unconfigured() {
      const messages: unknown[][] = [];

      const sender = yield* loadAlarmPush({
        names: ["phone-fixture"],
        secret,
      }).pipe(
        Effect.provideService(SecretStore, {
          add: () => Effect.void,
          exists: () => Effect.succeed(false),
          lease: () =>
            Effect.fail(
              new CliError({ reason: "Secret-store command refused" })
            ),
        }),
        Effect.provideService(Console.Console, {
          ...console,
          log: (...args: unknown[]) => {
            messages.push(args);
          },
        })
      );

      expect(sender).toBeNull();
      expect(messages).toEqual([
        [JSON.stringify({ action: "push.unconfigured" })],
      ]);
    })
);
