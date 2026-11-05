import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import { alarmCycle, emptyJournal } from "../../../stacks/nest/alarm.ts";
import type { AlarmPorts } from "../../../stacks/nest/alarm.ts";

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

it.effect.prop(
  "a second recently crashed reader notifies its owner without any phone page",
  [Schema.Boolean],
  ([switchboardFirst]) =>
    Effect.gen(function* joined() {
      const health = {
        complete: true,
        lastAck: null,
        lease: {
          expiresAt: 2_000_000,
          generation: 1,
          holder: "fixture",
          pane: null,
        },
        oldestWake: { at: 0, id: "3m7x2ka4xv22a", sender: "sender-invalid" },
        quietUnacked: 0,
      };

      const board = {
        alive: false,
        health,
        lastProgressAt: 20_000_000,
        name: "reader-a",
        owner: "board-owner",
      };

      const worker = {
        alive: false,
        health,
        lastProgressAt: 20_000_000,
        name: "sample/worker",
        owner: "worker-owner",
      };

      const notices: (readonly string[])[] = [];
      const pages: string[] = [];

      const ports: AlarmPorts<never> = {
        page: (text) =>
          Effect.sync(() => {
            pages.push(text);
          }),
        prepare: (key, recipients) =>
          Effect.sync(() => {
            if (key.startsWith("mail.stranded/")) {
              notices.push(recipients);
            }

            return [];
          }),
        save: () => Effect.void,
        send: () => Effect.void,
        unavailable: Effect.void,
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
        wakes: [switchboardFirst ? board : worker],
      };

      const first = yield* alarmCycle(
        emptyJournal,
        facts,
        20_000_000,
        settings,
        ports
      );

      expect(pages).toEqual([]);

      const together = yield* alarmCycle(
        first,
        { ...facts, wakes: [board, worker] },
        20_001_000,
        settings,
        ports
      );

      expect(notices).toHaveLength(2);
      expect(notices[1]).toContain(
        switchboardFirst ? "worker-owner" : "board-owner"
      );
      expect(pages).toEqual([]);

      yield* alarmCycle(
        together,
        { ...facts, wakes: [board, worker] },
        20_860_000,
        settings,
        ports
      );

      expect(pages).toEqual([]);
    })
);
