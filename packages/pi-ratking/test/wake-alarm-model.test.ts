/* oxlint-disable effect-tests/no-manual-effect-runtime-in-tests, typescript/promise-function-async -- Async model commands run with the captured test context through Promise thunks. */
// @effect-diagnostics asyncFunction:off -- fast-check async commands drive the Effect alarm cycle with fixture ports.
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import {
  STRANDED_MAIL_MS,
  busyMailLines,
} from "../../../stacks/nest/alarm-stranded.ts";
import type { WakeSighting } from "../../../stacks/nest/alarm-wakes.ts";
import {
  AlarmJournal,
  alarmCycle,
  emptyJournal,
} from "../../../stacks/nest/alarm.ts";
import type { AlarmJournalValue } from "../../../stacks/nest/alarm.ts";
import {
  healthy,
  recorder,
  runTicks,
  settings,
} from "../../alchemy-nest/test/maintenance-fixtures.ts";

const now = 1_800_000_000_000;

const wake = (
  name: string,
  alive: boolean,
  at: number,
  drained = false
): typeof WakeSighting.Type => ({
  alive,
  health: {
    complete: true,
    lastAck: null,
    lease: {
      expiresAt: at + 60_000,
      generation: 1,
      holder: "session-invalid",
      pane: null,
    },
    oldestWake: drained
      ? null
      : {
          at: now - 2 * STRANDED_MAIL_MS,
          id: "fixture-id",
          sender: "sender-invalid",
        },
    quietUnacked: 0,
  },
  lastProgressAt: at,
  lastTurnAt: at,
  name,
  owner: "reader-owner",
});

it.effect.prop(
  "busy live readers stay in the digest without any wake notice",
  {
    minutes: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 600, minimum: 1 }))
    ),
  },
  ({ minutes }) =>
    Effect.gen(function* busy() {
      const { pages, ports, sent } = recorder();
      const at = now + minutes * 60_000;

      const sightings = [
        wake("reader-a", true, at),
        wake("reader-b", true, at),
      ];

      yield* runTicks(
        emptyJournal,
        [
          { at: now, facts: { ...healthy, wakes: sightings } },
          { at, facts: { ...healthy, wakes: sightings } },
        ],
        ports
      );
      expect(pages).toEqual([]);
      expect(sent).toEqual([]);
      expect(busyMailLines(sightings, at)).toHaveLength(2);
    })
);

it.effect.prop(
  "legacy wake journals decode and disappear without sending queued notices",
  {
    recipient: Arbitrary.schema(Schema.String),
  },
  ({ recipient }) =>
    Effect.gen(function* retired() {
      const { ports, pages, sent } = recorder();

      const legacy = yield* Schema.decodeUnknownEffect(AlarmJournal)({
        ...emptyJournal,
        alarms: {
          "wake.unacked": {
            context: {
              lastSent: now,
              severity: "critical",
              since: now - STRANDED_MAIL_MS,
            },
            value: "firing",
          },
        },
        notices: [
          {
            incident: now,
            key: "wake.unacked",
            kind: "fire",
            recipients: ["owner-invalid"],
            text: "obsolete",
          },
        ],
        pages: [
          { at: now, incident: now - STRANDED_MAIL_MS, key: "wake.unacked" },
        ],
        pending: [
          {
            envelope: {
              aad: {
                messageId: "2222222222222",
                recipientDid: "did:web:recipient.invalid",
                recipientKeyId: "did:web:recipient.invalid#encryption",
                senderDid: "did:web:sender.invalid",
              },
              ciphertext: { $bytes: "AQ==" },
              enc: { $bytes: "AQ==" },
              suite: { aeadId: 0, kdfId: 0, kemId: 0 },
              version: 1,
            },
            key: "wake.unacked",
            recipient,
          },
        ],
      });

      const result = yield* alarmCycle(legacy, healthy, now, settings, {
        ...ports,
        send: () => Effect.die("retired delivery was sent"),
      });

      expect(result.alarms["wake.unacked"]).toBeUndefined();
      expect(result.pending).toEqual([]);
      expect(result.notices).toEqual([]);
      expect(pages).toEqual([]);
      expect(sent).toEqual([]);
    }),
  { arbitrary: { runs: 20 } }
);

interface Action {
  readonly reader: "reader-a" | "reader-b";
  readonly state: "dead" | "live" | "drained";
}

interface Model {
  states: Record<string, Action["state"]>;
  fires: Record<string, number>;
  clears: Record<string, number>;
}

interface Real {
  journal: AlarmJournalValue;
  tick: number;
  observed: ReturnType<typeof recorder>;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

const command = (action: Action): AsyncCommand<Model, Real> => ({
  check: () => true,
  run: Effect.fn("Test.stranded.model")(
    function* step(model: Model, real: Real) {
      const previous = model.states[action.reader];
      model.states[action.reader] = action.state;

      if (previous !== "dead" && action.state === "dead") {
        model.fires[action.reader] = (model.fires[action.reader] ?? 0) + 1;
      }

      if (previous === "dead" && action.state !== "dead") {
        model.clears[action.reader] = (model.clears[action.reader] ?? 0) + 1;
      }

      const at = now + real.tick * 20 * 60_000;
      real.tick += 1;

      const sightings = Object.entries(model.states).map(([name, state]) =>
        wake(name, state !== "dead", at, state === "drained")
      );

      real.journal = yield* runTicks(
        real.journal,
        [
          { at, facts: { ...healthy, wakes: sightings } },
          {
            at: at + 10 * 60_000,
            facts: {
              ...healthy,
              wakes: sightings.map((item) => ({
                ...item,
                health:
                  item.health === null
                    ? null
                    : {
                        ...item.health,
                        lease: {
                          expiresAt: at + 11 * 60_000,
                          generation: 1,
                          holder: "session-invalid",
                          pane: null,
                        },
                      },
              })),
            },
          },
        ],
        real.observed.ports
      );

      for (const [name, state] of Object.entries(model.states)) {
        const key = `mail.stranded/${name}`;
        expect(real.journal.alarms[key]?.value === "firing").toBe(
          state === "dead"
        );
        expect(
          new Set(
            real.observed.sent
              .filter(
                (notice) => notice.key === key && notice.text.startsWith("🚨")
              )
              .map(
                (notice) =>
                  /Incident (?<incident>\d+)/u.exec(notice.text)?.groups
                    ?.incident
              )
          ).size
        ).toBe(model.fires[name] ?? 0);
        expect(
          real.observed.sent.filter(
            (notice) => notice.key === key && notice.text.startsWith("✅")
          )
        ).toHaveLength(model.clears[name] ?? 0);
      }

      expect(
        real.observed.sent.some((notice) => notice.key === "wake.unacked")
      ).toBe(false);

      const firedPages = real.journal.pages.filter(
        (page) => page.kind !== "clear"
      );

      expect(
        new Set(firedPages.map((page) => `${page.key}:${page.incident}`)).size
      ).toBe(firedPages.length);

      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(real.journal);

      real.journal = yield* Schema.decodeEffect(
        Schema.fromJsonString(AlarmJournal)
      )(encoded);
    },
    async (effect, _model, real) => {
      await real.run(effect);
    }
  ),
  toString: () => `${action.reader}:${action.state}`,
});

it.effect.prop(
  "stranded incidents open and clear independently per reader across journal restarts",
  {
    actions: Arbitrary.schema(
      Schema.Array(
        Schema.Struct({
          reader: Schema.Literals(["reader-a", "reader-b"]),
          state: Schema.Literals(["dead", "live", "drained"]),
        })
      ).check(Schema.isMinLength(1), Schema.isMaxLength(15))
    ),
  },
  ({ actions }) =>
    Effect.gen(function* model() {
      const run = Effect.runPromiseWith(yield* Effect.context());

      const setup = {
        model: { clears: {}, fires: {}, states: {} },
        real: { journal: emptyJournal, observed: recorder(), run, tick: 0 },
      };

      yield* Effect.promise(
        asyncModelRun.bind(undefined, () => setup, actions.map(command))
      );
    })
);
