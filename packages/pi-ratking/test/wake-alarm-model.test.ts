/* oxlint-disable effect-tests/no-manual-effect-runtime-in-tests, typescript/promise-function-async -- Async model commands run with the captured test context through Promise thunks. */
// @effect-diagnostics asyncFunction:off -- fast-check async commands drive the Effect alarm cycle with fixture ports.
import { it } from "@effect/vitest";
import { Effect, Match, Schema } from "effect";
import * as fc from "fast-check";
import { expect } from "vitest";

import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import {
  WAKE_CRITICAL_MS,
  mergeWakeTargets,
} from "../../../stacks/nest/alarm-wakes.ts";
import {
  AlarmJournal,
  PAGE_ACK_WAIT_MS,
  alarmCycle,
  emptyJournal,
} from "../../../stacks/nest/alarm.ts";
import type {
  AlarmJournalValue,
  AlarmPorts,
} from "../../../stacks/nest/alarm.ts";

const Step = Schema.Literals([
  "wake",
  "wait",
  "ack",
  "missing",
  "expired",
  "absent",
]);

const Inputs = Schema.Struct({
  ackExpired: Schema.Boolean,
  configured: Schema.Boolean,
  steps: Schema.Array(Step).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(30)
  ),
  switchboard: Schema.Boolean,
  unackedMinutes: Schema.Int.check(
    Schema.isBetween({ maximum: 60, minimum: 1 })
  ),
});

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
  owners: {},
  page: { node: "node", script: "/fixture.invalid/page.mjs" },
});

interface Model {
  cleared: number;
  firing: boolean;
  now: number;
  paged: number;
  pagedIncident: number | null;
  since: number;
}

const WAIT_MS = 11 * 60_000;

interface Real {
  readonly oldest: number;
  readonly step: (step: typeof Step.Type) => Promise<void>;
  readonly state: () => AlarmJournalValue;
  readonly pages: string[];
  readonly notices: {
    readonly recipients: readonly string[];
    readonly text: string;
  }[];
}

const command = (
  step: typeof Step.Type,
  page: boolean,
  configured: boolean
): fc.AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (model, real) => {
    const before = real.notices.length;

    await real.step(step);
    model.now += step === "wait" ? WAIT_MS : 1000;

    const stalled =
      step === "wake" || step === "wait" || (configured && step === "expired");

    const wasFiring = model.firing;

    if (stalled) {
      model.since = wasFiring ? model.since : model.now;
      model.firing = true;

      if (
        page &&
        model.now - real.oldest > WAKE_CRITICAL_MS &&
        model.now - model.since >= PAGE_ACK_WAIT_MS &&
        model.pagedIncident !== model.since &&
        model.paged === 0
      ) {
        model.paged += 1;
        model.pagedIncident = model.since;
      }
    }

    if (step === "ack") {
      if (wasFiring && model.pagedIncident === model.since) {
        model.cleared += 1;
      }

      model.firing = false;
    }

    expect(real.state().alarms["wake.unacked"]?.value === "firing").toBe(
      model.firing
    );
    expect(real.pages.filter((text) => text.startsWith("🚨"))).toHaveLength(
      model.paged
    );
    expect(real.pages.filter((text) => text.startsWith("✅"))).toHaveLength(
      model.cleared
    );

    for (const notice of real.notices.slice(before)) {
      expect(notice.recipients).toContain("owner-invalid");
      expect(notice.text).toContain("wake.unacked");
    }
  },
  toString: () => step,
});

it.effect.prop(
  "wake alarm routes to owners without paging by default, pages opted-in targets and switchboard only once critical and confirmed, pages each paged clear, and preserves incidents across missing evidence and restarts",
  [Inputs],
  ([input]) =>
    Effect.gen(function* model() {
      for (const page of [undefined, false, true]) {
        const run = Effect.runPromiseWith(yield* Effect.context());

        const target = {
          name: input.switchboard ? "switchboard" : "mischief/worker",
          owner: "owner-invalid",
        };

        const policy = { ...target, unackedMinutes: input.unackedMinutes };

        const configured = page === undefined ? policy : { ...policy, page };

        const targets =
          mergeWakeTargets([target], input.configured ? [configured] : []) ??
          [];

        let journal = emptyJournal;
        let now = 1_000_000;

        const oldest =
          now - (input.configured ? input.unackedMinutes : 15) * 60_000;

        const notices: Real["notices"] = [];
        const pages: string[] = [];

        const ports: AlarmPorts<never> = {
          page: (text) =>
            Effect.sync(() => {
              pages.push(text);
            }),
          prepare: (key, recipients, text) =>
            Effect.sync(() => {
              if (key === "wake.unacked") {
                notices.push({ recipients, text });
              }

              return [];
            }),
          save: () => Effect.void,
          send: () => Effect.void,
          unavailable: Effect.void,
        };

        const real: Real = {
          notices,
          oldest,
          pages,
          state: () => journal,
          step: async (step) => {
            now += step === "wait" ? WAIT_MS : 1000;

            const health = {
              complete: true,
              lastAck: null,
              lease: {
                expiresAt:
                  step === "expired" || (step === "ack" && input.ackExpired)
                    ? now
                    : now + 60_000,
                generation: 1,
                holder: "fixture",
                pane: null,
              },
              oldestWake:
                step === "ack"
                  ? null
                  : {
                      at: oldest,
                      id: "3m7x2ka4xv22a",
                      sender: "sender-invalid",
                    },
              quietUnacked: 0,
            };

            const facts: typeof AlarmFacts.Type = {
              cacheBreaches: [],
              deploy: null,
              deployKnown: true,
              digest: "ok",
              doctor: true,
              entered: null,
              health: 200,
              measurementFailed: false,
              quarantinedHour: 0,
              readers: null,
              receipts: [],
              receiptsKnown: true,
              slots: { free: 100, max: 100 },
              wakes: Match.value(step).pipe(
                Match.when("missing", () => null),
                Match.when("absent", () => []),
                Match.orElse(() =>
                  targets.map((entry) => ({ ...entry, health }))
                )
              ),
            };

            journal = await run(
              alarmCycle(journal, facts, now, settings, ports).pipe(
                Effect.flatMap(
                  Schema.encodeEffect(Schema.fromJsonString(AlarmJournal))
                ),
                Effect.flatMap(
                  Schema.decodeEffect(Schema.fromJsonString(AlarmJournal))
                )
              )
            );
          },
        };

        yield* Effect.promise(() =>
          fc.asyncModelRun(
            () => ({
              model: {
                cleared: 0,
                firing: false,
                now: 1_000_000,
                paged: 0,
                pagedIncident: null,
                since: 0,
              },
              real,
            }),
            ["wake" as const, ...input.steps].map((step) =>
              command(
                step,
                input.switchboard || (input.configured && page === true),
                input.configured
              )
            )
          )
        );
      }
    })
);
