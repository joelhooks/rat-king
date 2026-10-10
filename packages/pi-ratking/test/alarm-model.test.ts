/* oxlint-disable effect-tests/no-manual-effect-runtime-in-tests -- Each runtime call bridges an asyncModelRun command using the live test context. */
/* oxlint-disable typescript/promise-function-async -- fast-check commands are Promise boundaries. */
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import {
  AlarmSettings,
  AlarmState,
} from "../../../stacks/nest/alarm-config.ts";
import type { AlarmStateValue } from "../../../stacks/nest/alarm-config.ts";
import {
  advanceAlarm,
  emptyAlarm,
} from "../../../stacks/nest/alarm-machine.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import {
  AlarmJournal,
  alarmCycle,
  emptyJournal,
  mayPage,
  alarmRecipients,
} from "../../../stacks/nest/alarm.ts";
import type {
  AlarmJournalValue,
  AlarmPorts,
} from "../../../stacks/nest/alarm.ts";
import { FleetError } from "../../../stacks/nest/stage-config.ts";
import * as Defs from "../../lexicon/src/defs.ts";

const settings = Schema.decodeUnknownSync(AlarmSettings)({
  broadcast: "observer-invalid",
  enabled: false,
  launchd: {
    errorLog: "/fixture.invalid/err",
    label: "alarm.invalid",
    node: "node",
    outputLog: "/fixture.invalid/out",
    path: "/fixture.invalid/bin",
    source: "/fixture.invalid",
  },
  musterDesk: "desk-invalid",
  notify: {
    directory: "/fixture.invalid/directory.json",
    secret: "operator.invalid",
  },
  owners: { issuer: "desk-invalid", ship: "owner-invalid" },
  page: { node: "node", script: "/fixture.invalid/page.mjs" },
  readers: [],
});

const facts: typeof AlarmFacts.Type = {
  deploy: null,
  deployKnown: true,
  digest: "ok",
  doctor: true,
  entered: null,
  health: 200,
  measurementFailed: false,
  quarantinedHour: 0,
  readers: {},
  receipts: [],
  receiptsKnown: true,
  slots: { free: 100, max: 100 },
};

const Cycle = Schema.Struct({
  minutes: Schema.Int.check(Schema.isBetween({ maximum: 180, minimum: 0 })),
  restart: Schema.Boolean,
  severity: Schema.Literals(["warn", "critical"]),
  status: Schema.Literals(["ok", "firing", "unknown"]),
});

interface Model {
  active: boolean;
  severity: "warn" | "critical";
  last: number;
  now: number;
}

interface Real {
  state: AlarmStateValue;
}

it.effect.prop(
  "alarm lifecycle emits once, raises severity, renotifies on time, clears once and resumes persisted state",
  [Schema.NonEmptyArray(Cycle)],
  ([cycles]) =>
    Effect.gen(function* lifecycle() {
      const context = yield* Effect.context();

      const commands = cycles.map((cycle): AsyncCommand<Model, Real> => ({
        check: () => true,
        run: (model, real) =>
          Effect.runPromiseWith(context)(
            Effect.gen(function* step() {
              model.now += cycle.minutes * 60_000;

              if (cycle.restart) {
                const encoded = yield* Schema.encodeEffect(
                  Schema.fromJsonString(AlarmState)
                )(real.state);

                real.state = yield* Schema.decodeEffect(
                  Schema.fromJsonString(AlarmState)
                )(encoded);
              }

              let expected: "fire" | "clear" | "none" = "none";

              if (cycle.status === "ok") {
                if (model.active) {
                  expected = "clear";
                }

                model.active = false;
              }

              if (cycle.status === "firing") {
                if (
                  !model.active ||
                  (cycle.severity === "critical" &&
                    model.severity === "warn") ||
                  model.now - model.last >= 7_200_000
                ) {
                  expected = "fire";
                  model.last = model.now;
                }

                model.active = true;
                model.severity = cycle.severity;
              }

              const next = advanceAlarm(
                real.state,
                cycle.status === "firing"
                  ? {
                      evidence: "known public cause",
                      severity: cycle.severity,
                      status: "firing",
                    }
                  : { status: cycle.status },
                model.now,
                7_200_000
              );

              real.state = next.state;
              expect(next.notice).toBe(expected);
              expect(real.state.value === "firing").toBe(model.active);
            })
          ),
      }));

      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({
            model: {
              active: false,
              last: -1,
              now: 0,
              severity: "warn" as const,
            },
            real: { state: emptyAlarm },
          }),
          commands
        )
      );
    })
);

const Attempt = Schema.Struct({
  deliver: Schema.Boolean,
  failed: Schema.Boolean,
  minutes: Schema.Int.check(Schema.isBetween({ maximum: 180, minimum: 0 })),
  prepare: Schema.Boolean,
  sha: Schema.Literals(["a".repeat(40), "b".repeat(40), "c".repeat(40)]),
});

interface DeliveryReal {
  journal: AlarmJournalValue;
  counter: number;
  accepted: Set<string>;
  observed: string[];
}

const deliveryPorts = (
  attempt: typeof Attempt.Type,
  real: DeliveryReal,
  template: typeof Defs.EncryptedEnvelope.Type
): AlarmPorts<never> => ({
  page: () => Effect.die("warn must never page"),
  prepare: (key, recipients) => {
    if (!attempt.prepare) {
      return Effect.fail(new FleetError({ reason: "Fixture offline" }));
    }

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes an effectful callback, not an Array thisArg.
    return Effect.forEach(recipients, (recipient) =>
      Effect.gen(function* prepare() {
        real.counter += 1;
        const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
        const id = `22222222222${alphabet[Math.floor(real.counter / 32) % 32]}${alphabet[real.counter % 32]}`;

        const envelope = yield* Schema.decodeUnknownEffect(
          Schema.toType(Defs.EncryptedEnvelope)
        )({ ...template, aad: { ...template.aad, messageId: id } });

        return { envelope, key, recipient };
      })
    ).pipe(
      Effect.mapError(
        () => new FleetError({ reason: "Fixture preparation failed" })
      )
    );
  },
  save: (checkpoint) =>
    Schema.encodeEffect(Schema.fromJsonString(AlarmJournal))(checkpoint).pipe(
      Effect.flatMap((encoded) =>
        Schema.decodeEffect(Schema.fromJsonString(AlarmJournal))(encoded)
      ),
      Effect.tap((restored) =>
        Effect.sync(() => {
          real.journal = restored;
        })
      ),
      Effect.asVoid,
      Effect.mapError(
        () => new FleetError({ reason: "Fixture journal failed" })
      )
    ),
  send: (item) => {
    if (!attempt.deliver) {
      return Effect.fail(
        new FleetError({ reason: "Fixture transport uncertain" })
      );
    }

    return Effect.sync(() => {
      const id = item.envelope.aad.messageId;

      if (!real.accepted.has(id)) {
        real.accepted.add(id);
        real.observed.push(`${item.recipient}:${id}`);
      }
    });
  },
  unavailable: Effect.void,
});

it.effect.prop(
  "changing failed commits share one incident; durable preparation/replay retains envelopes through failures",
  [Schema.NonEmptyArray(Attempt)],
  ([attempts]) =>
    Effect.gen(function* deliveryModel() {
      const context = yield* Effect.context();

      const template = yield* Schema.decodeUnknownEffect(
        Defs.EncryptedEnvelope
      )({
        aad: {
          messageId: "2222222222222",
          recipientDid: "did:web:observer.invalid",
          recipientKeyId: "did:web:observer.invalid#encryption",
          senderDid: "did:web:operator.invalid",
        },
        ciphertext: { $bytes: "AQ==" },
        enc: { $bytes: "AQ==" },
        suite: { aeadId: 0, kdfId: 0, kemId: 0 },
        version: 1,
      });

      const commands = attempts.map(
        (attempt): AsyncCommand<{ now: number }, DeliveryReal> => ({
          check: () => true,
          run: (model, real) =>
            Effect.runPromiseWith(context)(
              Effect.gen(function* step() {
                model.now += attempt.minutes * 60_000 + 1;
                const before = real.journal.alarms["ship.failed"];
                const oldNotices = real.journal.notices.length;
                const oldCounter = real.counter;

                const due =
                  attempt.failed &&
                  (before?.value !== "firing" ||
                    model.now - before.context.lastSent >= 7_200_000);

                const clear = !attempt.failed && before?.value === "firing";
                const ports = deliveryPorts(attempt, real, template);

                yield* alarmCycle(
                  real.journal,
                  {
                    ...facts,
                    receipts: [
                      {
                        celldRestarted: false,
                        end: model.now / 1000,
                        restartSeconds: 0,
                        result: attempt.failed ? "failed" : "success",
                        sha: attempt.sha,
                        start: model.now / 1000,
                        stderrTail: "Only a matching file may be adopted",
                      },
                    ],
                  },
                  model.now,
                  settings,
                  ports
                );

                expect(
                  real.journal.alarms["ship.failed"]?.value === "firing"
                ).toBe(attempt.failed);

                if (before?.value === "firing" && attempt.failed) {
                  expect(
                    real.journal.alarms["ship.failed"]?.context.since
                  ).toBe(before.context.since);
                }

                if (!due && !clear && oldNotices === 0) {
                  expect(real.counter).toBe(oldCounter);
                }

                expect(
                  real.journal.pending.every(
                    (item) => !real.accepted.has(item.envelope.aad.messageId)
                  )
                ).toBe(true);
                expect(real.observed.length).toBe(real.accepted.size);
              })
            ),
        })
      );

      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({
            model: { now: 0 },
            real: {
              accepted: new Set<string>(),
              counter: 0,
              journal: emptyJournal,
              observed: [],
            },
          }),
          commands
        )
      );
      expect(alarmRecipients(settings, "issuer.broken")).toEqual([
        "observer-invalid",
        "desk-invalid",
      ]);
    })
);

const Page = Schema.Struct({
  hours: Schema.Int.check(Schema.isBetween({ maximum: 24, minimum: 0 })),
  key: Schema.Literals([
    "ship.failed",
    "celld.down",
    "celld.restarted",
    "issuer.broken",
    "readers.stuck",
    "filer.slots",
    "quarantine.growth",
    "digest.fail",
  ]),
});

it.effect.prop(
  "Joel pages reserve at most six rolling-day slots and cannot repeat a key in six hours",
  [Schema.NonEmptyArray(Page)],
  ([events]) =>
    Effect.gen(function* pageModel() {
      const context = yield* Effect.context();

      const commands = events.map(
        (
          event
        ): AsyncCommand<
          { now: number },
          { pages: { key: (typeof Page.Type)["key"]; at: number }[] }
        > => ({
          check: () => true,
          run: (model, real) =>
            Effect.runPromiseWith(context)(
              Effect.sync(() => {
                model.now += event.hours * 3_600_000;

                if (mayPage(real.pages, event.key, model.now)) {
                  real.pages.push({ at: model.now, key: event.key });
                }

                const recent = real.pages.filter(
                  (page) => model.now - page.at < 86_400_000
                );

                expect(recent.length).toBeLessThanOrEqual(6);

                for (const [index, page] of recent.entries()) {
                  expect(
                    recent
                      .slice(index + 1)
                      .every(
                        (other) =>
                          other.key !== page.key ||
                          other.at - page.at >= 21_600_000
                      )
                  ).toBe(true);
                }
              })
            ),
        })
      );

      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({ model: { now: 0 }, real: { pages: [] } }),
          commands
        )
      );
    })
);
