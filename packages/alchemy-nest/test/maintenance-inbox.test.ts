import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  FileSystem,
  Option,
  PlatformError,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { SystemdAlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import {
  coveringWindow,
  readMaintenance,
} from "../../../stacks/nest/alarm-maintenance.ts";
import { PAGE_ACK_WAIT_MS, emptyJournal } from "../../../stacks/nest/alarm.ts";
import {
  MaintenancePreparationRefused,
  deliverMaintenance,
  ingestMaintenance,
} from "../../../stacks/nest/maintenance-inbox.ts";
import { publishMaintenanceStatus } from "../../../stacks/nest/maintenance-status.ts";
import { EncryptedEnvelope } from "../../lexicon/src/defs.ts";
import { healthy, recorder, runTicks } from "./maintenance-fixtures.ts";

const at = 1_800_000_000_000;

const hour = 3_600_000;

const timestamp = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

const requestId = (index: number, issued = at) =>
  `${(BigInt(issued) * 1_000_000n).toString().padStart(20, "0")}-${index.toString(16).padStart(32, "0")}`;

const seed = Effect.fn("Test.maintenanceInbox")(function* seed() {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const path = `${directory}/requests`;

  yield* fs.makeDirectory(path, { mode: 0o750 });
  const info = yield* fs.lstat(path);
  yield* TestClock.setTime(at);
  yield* fs.writeFileString(
    `${directory}/maintenance.json`,
    '{"version":1,"windows":[],"nextRuntime":{"retained":true}}\n'
  );

  const config = {
    alarmGid: Option.getOrThrow(info.gid),
    desk: "desk-fixture",
    directory,
    inbox: { operatorUid: Option.getOrThrow(info.uid), path },
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

  const dropPath = (index: number, issued = at) =>
    `${path}/${requestId(index, issued)}.json`;

  const request = (
    index: number,
    extra: Record<string, string> = {},
    issued = at
  ) =>
    fs.writeFileString(
      dropPath(index, issued),
      JSON.stringify({
        action: "start",
        id: requestId(index, issued),
        instance: "mailbox",
        owner: "owner-fixture",
        reason: "private fixture reason",
        until: timestamp(at + hour),
        ...extra,
      }),
      { mode: 0o640 }
    );

  return { config, dropPath, envelope, request };
});

it.effect(
  "inbox applies known windows and emits one bounded decision for every final drop",
  () =>
    Effect.gen(function* decisions() {
      const fs = yield* FileSystem.FileSystem;
      const { config, dropPath, envelope, request } = yield* seed();
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

      yield* request(1);
      yield* ingestMaintenance(config);
      yield* request(2, { id: requestId(99) });
      yield* request(3, { instance: "unlisted" });
      yield* request(4, { owner: "not an agent" });
      yield* request(5, { until: timestamp(at) });
      yield* request(6, { until: timestamp(at + 4 * hour + 1) });
      yield* request(7, { action: "end", instance: "fixture" });
      yield* request(8, { action: "end", owner: "other-fixture" });
      yield* request(9, { owner: "other-fixture" });
      yield* request(10, {
        action: "end",
        owner: config.desk,
        until: timestamp(at + 60_000),
      });
      yield* fs.symlink(dropPath(1), dropPath(11));
      yield* fs.writeFileString(dropPath(12), "x".repeat(4097), {
        mode: 0o640,
      });
      yield* fs.writeFileString(dropPath(13), "not json", { mode: 0o640 });
      yield* request(14, { until: "2027-02-30T00:00:00Z" });
      yield* request(15);
      yield* fs.chmod(dropPath(15), 0o660);
      yield* request(16, { action: "extend" });
      yield* request(17, { instance: "fixture" });
      yield* request(18, { action: "extend" });
      yield* request(19, { action: "extend" });
      yield* fs.writeFileString(`${inbox.path}/.staging.json`, "not final", {
        mode: 0o640,
      });
      yield* ingestMaintenance(config);
      yield* deliver;
      yield* deliver;
      yield* deliver;
      yield* deliver;

      const expected = [
        `maintenance start on mailbox by owner-fixture until ${timestamp(at + hour)}`,
        "refused: request id does not match filename",
        "refused: unknown instance",
        "refused: invalid request file or JSON",
        "refused: request deadline must be in the next four hours",
        "refused: request deadline must be in the next four hours",
        "refused: no open window",
        "refused: end requires the window owner or desk",
        "refused: start requires the window owner or desk",
        "maintenance end on mailbox by desk-fixture now",
        "refused: invalid request file or JSON",
        "refused: invalid request file or JSON",
        "refused: invalid request file or JSON",
        "refused: invalid until",
        "refused: invalid request file or JSON",
        `maintenance start on fixture by owner-fixture until ${timestamp(at + hour)}`,
      ];

      expect(notices).toEqual(
        expected.map(
          (message, index) =>
            `${message} (${requestId(index < 14 ? index + 1 : index + 2)})`
        )
      );

      yield* TestClock.setTime(at + 1);
      yield* request(20, { action: "end", instance: "fixture" });
      yield* ingestMaintenance(config);
      yield* deliver;
      expect(notices.at(-1)).toBe(
        `maintenance end on fixture by owner-fixture now (${requestId(20)})`
      );
      expect(notices).toHaveLength(19);

      const windows = yield* readMaintenance(directory);

      expect(windows.filter(({ instance }) => instance === "mailbox")).toEqual([
        {
          ended: at,
          graceMinutes: 5,
          instance: "mailbox",
          owner: "owner-fixture",
          reason: "private fixture reason",
          requestId: requestId(1),
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

      yield* fs.chmod(dropPath(15), 0o640);
      yield* ingestMaintenance(config);
      yield* deliver;
      expect(notices.at(-1)).toBe(
        `maintenance start on mailbox by owner-fixture until ${timestamp(at + hour)} (${requestId(15)})`
      );
      expect(notices).toHaveLength(20);
      yield* ingestMaintenance(config);
      yield* deliver;
      expect(notices).toHaveLength(20);
      expect(yield* fs.exists(dropPath(1))).toBe(true);
      expect(
        yield* fs.readFileString(`${directory}/maintenance.json`)
      ).toContain('"nextRuntime":{"retained":true}');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "maintenance suppresses paging until expiry and preserves queued and prepared notices after drop removal",
  () =>
    Effect.gen(function* replay() {
      const fs = yield* FileSystem.FileSystem;
      const { config, dropPath, envelope, request } = yield* seed();
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

      yield* request(1);
      yield* ingestMaintenance(config);
      yield* deliver;
      yield* request(2, { instance: "fixture" });
      yield* ingestMaintenance(config);
      yield* fs.remove(dropPath(1));
      yield* fs.remove(dropPath(2));
      yield* TestClock.setTime(at + 24 * hour + 1);
      yield* ingestMaintenance(config);
      yield* deliver;
      yield* deliver;

      expect(prepared).toBe(2);
      expect(attempts).toEqual([envelope, envelope, envelope]);

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

it.effect(
  "only the configured uid can publish; a symlink swapped after lstat is retried",
  () =>
    Effect.gen(function* trust() {
      const fs = yield* FileSystem.FileSystem;
      const { config, dropPath, request } = yield* seed();
      const ingest = ingestMaintenance(config);
      const { path, operatorUid } = config.inbox;
      const link = `${config.directory}/linked-requests`;
      const file = dropPath(1);
      const moved = `${file}.moved`;

      const untrusted = {
        reason: "Maintenance inbox directory is not trusted",
      };

      yield* request(1, { owner: config.desk });
      yield* fs.symlink(path, link);
      expect(
        yield* ingestMaintenance({
          ...config,
          inbox: { ...config.inbox, path: link },
        }).pipe(Effect.flip)
      ).toMatchObject(untrusted);
      expect(
        yield* ingestMaintenance({
          ...config,
          inbox: { ...config.inbox, operatorUid: operatorUid + 1 },
        }).pipe(Effect.flip)
      ).toMatchObject(untrusted);
      yield* fs.chmod(path, 0o770);
      expect(yield* ingest.pipe(Effect.flip)).toMatchObject(untrusted);
      yield* fs.chmod(path, 0o2750);

      const substitute: typeof fs.open = (filePath, options) =>
        filePath === file
          ? Effect.gen(function* swap() {
              yield* fs.rename(file, moved);
              yield* fs.symlink(moved, file);

              return yield* fs.open(filePath, options);
            })
          : fs.open(filePath, options);

      yield* ingest.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: substitute,
        })
      );
      expect(yield* readMaintenance(config.directory)).toEqual([]);
      expect(
        yield* fs.readFileString(`${config.directory}/maintenance.json`)
      ).not.toContain(requestId(1));
      yield* fs.remove(file);
      yield* fs.rename(moved, file);

      const pretendUid = (filePath: string) =>
        fs
          .lstat(filePath)
          .pipe(
            Effect.map((info) =>
              filePath === file
                ? { ...info, uid: Option.some(operatorUid + 1) }
                : info
            )
          );

      yield* TestClock.setTime(at + 600_001);
      yield* ingest.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          lstat: pretendUid,
        })
      );
      yield* ingest;
      expect(yield* readMaintenance(config.directory)).toEqual([]);
      expect(
        yield* fs.readFileString(`${config.directory}/maintenance.json`)
      ).toContain("refused: request unreadable or wrong owner, group or mode");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "lost history cannot revive an old start; only absent records older than a day are pruned",
  () =>
    Effect.gen(function* prune() {
      const fs = yield* FileSystem.FileSystem;
      const { config, dropPath, request } = yield* seed();
      const file = `${config.directory}/maintenance.json`;
      const old = at - 4 * hour - 1;
      const absent = `${requestId(2)}.json`;
      const kept = `${requestId(3)}.json`;

      const sent = Schema.TaggedStruct("Sent", { decidedAt: Schema.Int }).make({
        decidedAt: at - 24 * hour,
      });

      yield* request(1, {}, old);
      yield* request(3);
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          requests: { [absent]: sent, [kept]: sent },
          version: 1,
          windows: [],
        })
      );
      yield* ingestMaintenance(config);
      expect(yield* readMaintenance(config.directory)).toEqual([]);

      const before = yield* fs.readFileString(file);

      expect(before).toContain(
        "request ID timestamp is outside the last four hours"
      );
      expect(before).toContain(absent);
      yield* TestClock.setTime(at + 1);
      yield* ingestMaintenance(config);

      const after = yield* fs.readFileString(file);

      expect(after).not.toContain(absent);
      expect(after).toContain(kept);
      expect(yield* fs.exists(dropPath(3))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "desk status is atomic and redacted, and does not guess legacy decisions",
  [SystemdAlarmSettings, Schema.Boolean],
  ([alarm, trusted]) =>
    Effect.gen(function* status() {
      const fs = yield* FileSystem.FileSystem;
      const { config, envelope, request } = yield* seed();
      const { directory } = config;
      const statusDirectory = `${directory}/desk`;
      const path = `${statusDirectory}/status.json`;
      const stateFile = `${directory}/maintenance.json`;

      const legacy = Schema.TaggedStruct("Sent", {
        decidedAt: Schema.Int,
      }).make({ decidedAt: at - 1 });

      yield* fs.writeFileString(
        stateFile,
        JSON.stringify({
          requests: { [`${requestId(7)}.json`]: legacy },
          version: 1,
          windows: [],
        })
      );
      yield* request(1);
      yield* ingestMaintenance(config);
      yield* request(2, { action: "end" });
      yield* request(3, { instance: "unlisted" });
      yield* TestClock.setTime(at + 1);
      yield* ingestMaintenance(config);
      yield* deliverMaintenance(directory, {
        prepare: () => Effect.succeed({ envelope, recipient: config.desk }),
        send: () => Effect.void,
        unavailable: Effect.die("unexpected delivery failure"),
      });

      yield* fs.makeDirectory(statusDirectory);
      yield* fs.chmod(statusDirectory, trusted ? 0o2750 : 0o2770);

      const settings = {
        ...alarm,
        maintenanceStatusPath: path,
        sources: { doctor: false },
      };

      const heartbeat = { at, consecutiveFailures: 0, outcome: "ok" as const };
      const publish = publishMaintenanceStatus(settings, directory, heartbeat);

      if (!trusted) {
        yield* Effect.flip(publish);
        expect(yield* fs.exists(path)).toBe(false);

        return;
      }

      yield* publish;
      const first = yield* fs.lstat(path);
      const text = yield* fs.readFileString(path);

      expect(first.mode % 0o1000).toBe(0o640);
      expect(text).not.toMatch(
        /private fixture reason|did:web|ciphertext|\.json|envelope|unlisted/u
      );
      expect(JSON.parse(text)).toEqual({
        alarmSources: { doctor: "off" },
        generatedAt: at + 1,
        heartbeat: { ageMs: 1, at, outcome: "ok" },
        requests: [
          {
            decidedAt: at + 1,
            decision: "applied",
            delivery: "sent",
            ended: at + 1,
            id: requestId(2),
            instance: "mailbox",
            owner: "owner-fixture",
            start: at,
            until: at + hour,
          },
          {
            decidedAt: at + 1,
            decision: "refused",
            delivery: "sent",
            id: requestId(3),
            owner: "owner-fixture",
          },
          {
            decidedAt: at,
            decision: "applied",
            delivery: "sent",
            id: requestId(1),
            instance: "mailbox",
            owner: "owner-fixture",
            start: at,
            until: at + hour,
          },
          {
            decidedAt: at - 1,
            decision: "unknown",
            delivery: "sent",
            id: requestId(7),
          },
        ],
        truncated: false,
        version: 1,
        windows: [
          {
            ended: at + 1,
            id: requestId(1),
            instance: "mailbox",
            owner: "owner-fixture",
            start: at,
            until: at + hour,
          },
        ],
      });

      yield* publish;
      const second = yield* fs.lstat(path);

      expect(second.ino).not.toEqual(first.ino);
      expect(yield* fs.readDirectory(statusDirectory)).toEqual(["status.json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 } }
);

it.effect.prop(
  "status output stays bounded under journal history growth",
  [
    SystemdAlarmSettings,
    Schema.Int.check(Schema.isBetween({ maximum: 160, minimum: 129 })),
  ],
  ([alarm, count]) =>
    Effect.gen(function* bounded() {
      const fs = yield* FileSystem.FileSystem;
      const { config } = yield* seed();
      const { directory } = config;
      const statusDirectory = `${directory}/desk`;
      const path = `${statusDirectory}/status.json`;

      const legacy = Schema.TaggedStruct("Dropped", {
        decidedAt: Schema.Int,
      }).make({ decidedAt: at });

      const requests = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `${requestId(index)}.json`,
          legacy,
        ])
      );

      const windows = Array.from({ length: count }, (_, index) => ({
        graceMinutes: 5,
        instance: `fixture-${index}`,
        owner: "operator-fixture",
        reason: "private fixture reason",
        start: at,
        until: at + hour,
      }));

      yield* fs.writeFileString(
        `${directory}/maintenance.json`,
        JSON.stringify({ requests, version: 1, windows })
      );
      yield* fs.makeDirectory(statusDirectory);
      yield* fs.chmod(statusDirectory, 0o2750);
      yield* publishMaintenanceStatus(
        { ...alarm, maintenanceStatusPath: path },
        directory,
        { at, consecutiveFailures: 0, outcome: "ok" }
      );

      const bytes = yield* fs.readFile(path);

      const projected = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            requests: Schema.Array(
              Schema.Struct({
                decision: Schema.Literal("unknown"),
                delivery: Schema.Literal("dropped"),
              })
            ),
            truncated: Schema.Literal(true),
            windows: Schema.Array(Schema.Unknown),
          })
        )
      )(new TextDecoder().decode(bytes));

      expect(bytes.byteLength).toBeLessThanOrEqual(65_536);
      expect(projected.requests).toHaveLength(128);
      expect(projected.windows).toHaveLength(64);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 } }
);

it.effect.prop(
  "a permanently unpreparable notice gets one generic refusal or drops it if that cannot be prepared",
  [Schema.Boolean],
  ([canPrepareRefusal]) =>
    Effect.gen(function* fallback() {
      const { config, envelope, request } = yield* seed();
      const attempts: string[] = [];
      const sent: string[] = [];
      let unavailable = 0;

      const deliver = deliverMaintenance(config.directory, {
        prepare: (text) =>
          Effect.suspend(() => {
            attempts.push(text);

            return !canPrepareRefusal || text.startsWith("maintenance start")
              ? Effect.fail(new MaintenancePreparationRefused())
              : Effect.succeed({ envelope, recipient: config.desk });
          }),
        send: ({ recipient }) =>
          Effect.sync(() => {
            sent.push(recipient);
          }),
        unavailable: Effect.sync(() => {
          unavailable += 1;
        }),
      });

      yield* request(1);
      yield* ingestMaintenance(config);
      yield* deliver;
      yield* deliver;
      yield* deliver;
      expect(attempts).toEqual([
        `maintenance start on mailbox by owner-fixture until ${timestamp(at + hour)} (${requestId(1)})`,
        `maintenance notice refused: could not prepare original decision (${requestId(1)})`,
      ]);
      expect(sent).toEqual(canPrepareRefusal ? [config.desk] : []);
      expect(unavailable).toBe(canPrepareRefusal ? 0 : 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "EACCES, wrong mode and wrong GID each get one refusal after ten minutes",
  () =>
    Effect.gen(function* faults() {
      const fs = yield* FileSystem.FileSystem;
      const { config, dropPath, envelope, request } = yield* seed();
      const notes: string[] = [];

      const access = Schema.TaggedStruct("PermissionDenied", {
        method: Schema.String,
        module: Schema.String,
        syscall: Schema.String,
      }).make({ method: "open", module: "FileSystem", syscall: "EACCES" });

      const overridden = FileSystem.FileSystem.of({
        ...fs,
        lstat: (file) =>
          fs.lstat(file).pipe(
            Effect.map((info) =>
              file === dropPath(3)
                ? {
                    ...info,
                    gid: info.gid.pipe(Option.map((gid) => gid + 1)),
                  }
                : info
            )
          ),
        open: (file, options) =>
          file === dropPath(1)
            ? Effect.fail(PlatformError.systemError(access))
            : fs.open(file, options),
      });

      const ingest = ingestMaintenance(config).pipe(
        Effect.provideService(FileSystem.FileSystem, overridden)
      );

      const deliver = deliverMaintenance(config.directory, {
        prepare: (text) =>
          Effect.sync(() => {
            notes.push(text);

            return { envelope, recipient: config.desk };
          }),
        send: () => Effect.void,
        unavailable: Effect.die("refusal must be deliverable"),
      });

      yield* Effect.forEach([1, 2, 3], (index) => request(index));
      yield* fs.chmod(dropPath(2), 0o644);
      yield* TestClock.setTime(at + 600_000);
      yield* ingest;
      yield* deliver;
      expect(notes).toEqual([]);
      yield* TestClock.setTime(at + 600_001);
      yield* ingest;
      yield* deliver;
      yield* ingest;
      yield* deliver;
      expect(notes).toEqual(
        [1, 2, 3].map(
          (index) =>
            `refused: request unreadable or wrong owner, group or mode (${requestId(index)})`
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "an expired end fences an earlier still-live start after journal loss",
  () =>
    Effect.gen(function* cancelled() {
      const fs = yield* FileSystem.FileSystem;
      const { config, request } = yield* seed();
      const file = `${config.directory}/maintenance.json`;
      const ingest = ingestMaintenance(config);

      yield* request(1);
      yield* ingest;
      expect(yield* readMaintenance(config.directory)).toHaveLength(1);
      yield* request(2, { action: "end", until: timestamp(at + 60_000) });
      yield* ingest;
      expect(yield* readMaintenance(config.directory)).toMatchObject([
        { ended: at },
      ]);

      yield* fs.remove(file);
      yield* TestClock.setTime(at + 120_000);
      yield* ingest;
      expect(yield* readMaintenance(config.directory)).toEqual([]);
      expect(yield* fs.readFileString(file)).toContain(
        "start superseded by a later end"
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "future timestamps are deferred on first sight; only excessive skew is refused on a later tick",
  () =>
    Effect.gen(function* clock() {
      const fs = yield* FileSystem.FileSystem;
      const { config, request } = yield* seed();
      const file = `${config.directory}/maintenance.json`;
      const ingest = ingestMaintenance(config);

      yield* request(1, {}, at + 300_000);
      yield* request(2, {}, at + 300_001);
      yield* ingest;
      expect(yield* fs.readFileString(file)).not.toContain("refused:");
      yield* ingest;
      expect(yield* fs.readFileString(file)).toContain(
        `more than five minutes ahead (${requestId(2, at + 300_001)})`
      );
      expect(yield* readMaintenance(config.directory)).toEqual([]);
      yield* TestClock.setTime(at + 300_000);
      yield* ingest;
      expect(yield* readMaintenance(config.directory)).toMatchObject([
        { requestId: requestId(1, at + 300_000) },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
