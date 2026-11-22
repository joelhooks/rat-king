import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  coveringWindow,
  readMaintenance,
} from "../../../stacks/nest/alarm-maintenance.ts";
import { PAGE_ACK_WAIT_MS, emptyJournal } from "../../../stacks/nest/alarm.ts";
import {
  deliverMaintenance,
  ingestMaintenance,
} from "../../../stacks/nest/maintenance-inbox.ts";
import { EncryptedEnvelope } from "../../lexicon/src/defs.ts";
import { healthy, recorder, runTicks } from "./maintenance-fixtures.ts";

const at = 1_800_000_000_000;

const hour = 3_600_000;

const timestamp = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

const seed = Effect.fn("Test.maintenanceInbox")(function* seed() {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const inbox = `${directory}/requests`;

  yield* fs.makeDirectory(inbox);
  yield* TestClock.setTime(at);
  yield* fs.writeFileString(
    `${directory}/maintenance.json`,
    '{"version":1,"windows":[]}\n'
  );

  const config = {
    desk: "desk-fixture",
    directory,
    inbox,
    instances: ["fixture"],
  };

  const envelope = yield* Schema.decodeUnknownEffect(EncryptedEnvelope)({
    aad: {
      messageId: "2222222222222",
      recipientDid: "did:web:desk.example.invalid",
      recipientKeyId: "did:web:desk.example.invalid#encryption",
      senderDid: "did:web:operator.example.invalid",
    },
    ciphertext: { $bytes: "AQ==" },
    enc: { $bytes: "AQ==" },
    suite: { aeadId: 0, kdfId: 0, kemId: 0 },
    version: 1,
  });

  const request = (id: string, extra: Record<string, string> = {}) =>
    fs.writeFileString(
      `${inbox}/${id}.json`,
      JSON.stringify({
        action: "start",
        id,
        instance: "mailbox",
        owner: "owner-fixture",
        reason: "private fixture reason",
        until: timestamp(at + hour),
        ...extra,
      }),
      { mode: 0o640 }
    );

  return { config, envelope, request };
});

it.effect(
  "inbox applies known windows and emits one bounded decision for every final drop",
  () =>
    Effect.gen(function* decisions() {
      const fs = yield* FileSystem.FileSystem;
      const { config, envelope, request } = yield* seed();
      const { directory, inbox } = config;
      const notices: string[] = [];

      const deliver = deliverMaintenance(directory, {
        prepare: (text) =>
          Effect.sync(() => {
            notices.push(text);

            return { envelope, recipient: config.desk };
          }),
        send: () => Effect.void,
        unavailable: Effect.die("fixture delivery is available"),
      });

      yield* request("01-start");
      yield* request("02-id", { id: "other" });
      yield* request("03-unknown", { instance: "unlisted" });
      yield* request("04-owner", { owner: "not an agent" });
      yield* request("05-past", { until: timestamp(at) });
      yield* request("06-far", { until: timestamp(at + 4 * hour + 1) });
      yield* request("07-no-open", { action: "end", instance: "fixture" });
      yield* request("08-end-owner", { action: "end", owner: "other-fixture" });
      yield* request("09-end", { action: "end", owner: config.desk });
      yield* fs.symlink(`${inbox}/01-start.json`, `${inbox}/10-link.json`);
      yield* fs.writeFileString(`${inbox}/11-large.json`, "x".repeat(4097), {
        mode: 0o640,
      });
      yield* fs.writeFileString(`${inbox}/12-json.json`, "not json", {
        mode: 0o640,
      });
      yield* request("13-date", { until: "2027-02-30T00:00:00Z" });
      yield* request("14-mode");
      yield* fs.chmod(`${inbox}/14-mode.json`, 0o660);
      yield* request("15-action", { action: "extend" });
      yield* fs.writeFileString(`${inbox}/.staging.json`, "not final", {
        mode: 0o640,
      });
      yield* ingestMaintenance(config);
      yield* deliver;
      yield* deliver;
      yield* deliver;
      yield* deliver;

      expect(notices).toEqual([
        `maintenance start on mailbox by owner-fixture until ${timestamp(at + hour)} (01-start)`,
        "refused: request id does not match filename (02-id)",
        "refused: unknown instance (03-unknown)",
        "refused: invalid request file or JSON (04-owner)",
        "refused: until must be in the next four hours (05-past)",
        "refused: until must be in the next four hours (06-far)",
        "refused: no open window (07-no-open)",
        "refused: end requires the window owner or desk (08-end-owner)",
        `maintenance end on mailbox by desk-fixture until ${timestamp(at + hour)} (09-end)`,
        "refused: invalid request file or JSON (10-link)",
        "refused: invalid request file or JSON (11-large)",
        "refused: invalid request file or JSON (12-json)",
        "refused: invalid until (13-date)",
        "refused: invalid request file or JSON (14-mode)",
        "refused: invalid request file or JSON (15-action)",
      ]);

      const windows = yield* readMaintenance(directory);

      expect(windows).toEqual([
        {
          ended: at,
          graceMinutes: 5,
          instance: "mailbox",
          owner: "owner-fixture",
          reason: "private fixture reason",
          requestId: "01-start",
          start: at,
          until: at + hour,
        },
      ]);
      expect(
        coveringWindow({ maintenance: windows }, "mailbox", at + 300_000)
      ).toBeDefined();
      expect(
        coveringWindow({ maintenance: windows }, "mailbox", at + 300_001)
      ).toBeUndefined();

      yield* TestClock.setTime(at + 1);
      yield* ingestMaintenance(config);
      yield* deliver;
      expect(notices).toHaveLength(15);
      expect(yield* readMaintenance(directory)).toEqual(windows);
      expect(yield* fs.exists(`${inbox}/01-start.json`)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "maintenance suppresses paging until expiry and retries the same prepared desk envelope after a lost reply",
  () =>
    Effect.gen(function* replay() {
      const { config, envelope, request } = yield* seed();
      const { directory } = config;
      const { pages, ports, sent } = recorder();
      const attempts: (typeof EncryptedEnvelope.Type)[] = [];
      let prepared = 0;

      const deliver = deliverMaintenance(directory, {
        prepare: () =>
          Effect.sync(() => {
            prepared += 1;

            return { envelope, recipient: config.desk };
          }),
        send: (notice) =>
          Effect.suspend(() => {
            attempts.push(notice.envelope);

            return attempts.length === 1
              ? Effect.fail("reply lost")
              : Effect.void;
          }),
        unavailable: Effect.void,
      });

      yield* request("01-start");
      yield* ingestMaintenance(config);
      yield* deliver;
      yield* ingestMaintenance(config);
      yield* deliver;
      yield* deliver;

      expect(prepared).toBe(1);
      expect(attempts).toEqual([envelope, envelope]);

      const maintenance = yield* readMaintenance(directory);
      const facts = { ...healthy, health: 503, maintenance };

      const during = yield* runTicks(
        emptyJournal,
        [0, 1, PAGE_ACK_WAIT_MS + 1].map((offset) => ({
          at: at + offset,
          facts,
        })),
        ports
      );

      expect(pages).toEqual([]);

      const expired = at + hour + 300_001;
      yield* runTicks(
        during,
        [0, 1, PAGE_ACK_WAIT_MS + 1].map((offset) => ({
          at: expired + offset,
          facts,
        })),
        ports
      );

      expect(pages).toHaveLength(1);
      expect(
        sent.some(({ text }) => text.includes("private fixture reason"))
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
