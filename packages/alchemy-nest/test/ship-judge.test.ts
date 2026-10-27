import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Console,
  DateTime,
  Effect,
  FileSystem,
  Match,
  Path,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  classifyShip,
  gitIn,
  judgeShip,
  OneWay,
  Pass,
  Revertible,
  revertibility,
  shipJudgeCommand,
  ShipLimits,
  ShipVerdict,
  shipWindows,
  SingleRecipient,
} from "../../../stacks/nest/ship-judge.ts";
import type {
  JudgeHealth,
  WindowFacts,
} from "../../../stacks/nest/ship-judge.ts";
import { usageDigest, usageWindow } from "../../../stacks/nest/usage.ts";
import type { TrafficEvent } from "../../../stacks/nest/usage.ts";

const Small = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum: 0 }));

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const recipientDid = (index: number) =>
  `did:web:fixture.recipient${index % 2}.pi.fleet.invalid`;

const event = (
  messageId: string,
  state: TrafficEvent["state"],
  time: number,
  recipient = recipientDid(0)
): TrafficEvent => ({
  messageId,
  recipientDid: recipient,
  recipientSeq: 1,
  senderDid: "did:web:fixture.sender.pi.fleet.invalid",
  seq: 1,
  state,
  time: iso(time),
});

const Lifecycle = Schema.Struct({
  ack: Schema.Boolean,
  deliveries: Small(3),
  latency: Small(5000),
  offset: Small(600_000),
});

it.effect.prop(
  "a window over one day folds exactly like the day digest",
  [Schema.Array(Lifecycle)],
  ([lifecycles]) =>
    Effect.gen(function* windowParity() {
      const day = "2026-10-12";
      const start = Date.parse(`${day}T00:00:00Z`);

      const events = lifecycles.flatMap((step, index) => [
        event(`m-${index}`, "accepted", start + step.offset),
        ...Array.from({ length: step.deliveries }, (_, replay) =>
          event(`m-${index}`, "delivered", start + step.offset + replay + 1)
        ),
        ...(step.ack
          ? [event(`m-${index}`, "acked", start + step.offset + step.latency)]
          : []),
      ]);

      events.push(event("live", "delivered", start + 1));

      const window = yield* usageWindow(
        { end: start + 86_400_000, start },
        Stream.fromIterable(events)
      );

      const digest = yield* usageDigest(day, Stream.fromIterable(events));

      expect(window).toMatchObject({
        ackLatency: digest.ackLatency,
        acked: digest.acked,
        delivered: digest.delivered,
        replays: digest.replays,
        sent: digest.sent,
        undelivered: digest.undelivered,
      });
    })
);

const readerlessRecipient = (index: number) =>
  `did:web:fixture.readerless${index}.pi.fleet.invalid`;

const burst = (
  from: number,
  delivered: number,
  recipients: readonly string[],
  extraReaders: readonly string[] = []
) => [
  ...Array.from({ length: delivered }, (_, index) => {
    const id = `d-${from}-${index}`;

    return [
      event(id, "accepted", from + index * 10),
      event(id, "delivered", from + index * 10 + 5),
    ];
  }).flat(),
  ...recipients.map((recipient, index) =>
    event(`r-${from}-${index}`, "accepted", from + 3000 + index, recipient)
  ),
  ...extraReaders.map((recipient, index) =>
    event(`s-${from}-${index}`, "accepted", from + 4000 + index, recipient)
  ),
];

const windowOf = (events: readonly TrafficEvent[], start: number) =>
  usageWindow({ end: start + 600_000, start }, Stream.fromIterable(events));

it.effect(
  "mail accepted only for recipients that never receive anything is excluded and counted",
  () =>
    Effect.gen(function* readerlessExcluded() {
      const start = Date.parse("2026-10-27T16:50:00Z");
      const sha = "a".repeat(40);

      const dead = Array.from({ length: 7 }, (_, index) =>
        readerlessRecipient(index)
      );

      const baseline = yield* windowOf(
        burst(start - 600_000, 96, []),
        start - 600_000
      );

      const after = yield* windowOf(burst(start, 96, dead), start);

      expect(after).toMatchObject({ readerless: 7, sent: 96, undelivered: 0 });

      const verdict = judgeShip({
        after,
        baseline,
        health: { listeners: { count: 2, expected: 2 }, status: "ok" },
        sha,
      });

      expect(verdict).toMatchObject({ readerless: 7 });
      expect(Schema.is(Pass)(verdict)).toBe(true);
    })
);

it.effect(
  "undelivered mail to a recipient that has deliveries in the window still fails",
  () =>
    Effect.gen(function* liveReaderStillFails() {
      const start = Date.parse("2026-10-27T16:50:00Z");
      const live = [recipientDid(0), recipientDid(1)];

      const stuck = Array.from({ length: 12 }, (_, index) =>
        event(`u-${index}`, "accepted", start + 5000 + index, live[index % 2])
      );

      const events = [
        ...burst(start, 96, []),
        event("w", "accepted", start + 1, recipientDid(1)),
        event("w", "delivered", start + 2, recipientDid(1)),
        ...stuck,
      ];

      const after = yield* windowOf(events, start);

      const baseline = yield* windowOf(
        burst(start - 600_000, 96, []),
        start - 600_000
      );

      expect(after.readerless).toBe(0);

      const verdict = judgeShip({
        after,
        baseline,
        health: { listeners: { count: 2, expected: 2 }, status: "ok" },
        sha: "a".repeat(40),
      });

      expect(verdict._tag).toBe("Fail");
    })
);

const facts = (input: {
  readonly acked: number;
  readonly p95: number | null;
  readonly recipients?: number;
  readonly sent: number;
  readonly undelivered: number;
}): WindowFacts => {
  const spread = Math.min(input.recipients ?? 2, input.undelivered);

  return {
    ackLatency: { p50: null, p95: null },
    acked: input.acked,
    delivered: Math.max(0, input.sent - input.undelivered),
    deliveryLatency: { p50: input.p95, p95: input.p95 },
    end: "",
    replays: 0,
    sent: input.sent,
    start: "",
    undelivered: input.undelivered,
    undeliveredRecipients: Array.from({ length: spread }, (_, index) => ({
      count:
        Math.floor(input.undelivered / spread) +
        (index < input.undelivered % spread ? 1 : 0),
      did: recipientDid(index),
    })),
  };
};

const Baseline = Schema.Struct({
  acked: Small(200),
  p95: Small(5000),
  sent: Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 20 })),
  undelivered: Small(20),
});

const Degradation = Schema.Struct({
  delta: Schema.Int.check(Schema.isBetween({ maximum: 30, minimum: -30 })),
  kind: Schema.Literals([
    "DeliveryRateDrop",
    "DeliveryLatencyRegression",
    "ListenersMissing",
    "HealthStatus",
  ]),
});

const statusFor = (delta: number): JudgeHealth["status"] => {
  if (delta === 0) {
    return "ok";
  }

  return delta > 0 ? "fail" : "warn";
};

const okHealth = {
  listeners: { count: 10, expected: 10 },
  status: "ok",
} as const;

it.effect.prop(
  "an unchanged ship passes, and each degradation fails with only its own tag once it crosses its named limit",
  [Baseline, Degradation],
  ([sample, { delta, kind }]) =>
    Effect.sync(() => {
      const acked = Math.min(sample.acked, sample.sent);
      const baseline = facts({ ...sample, acked });
      const sha = "a".repeat(40);

      expect(
        judgeShip({ after: baseline, baseline, health: okHealth, sha })._tag
      ).toBe("Pass");

      const latencyEdge =
        ShipLimits.latencyFactor * sample.p95 + ShipLimits.latencySlackMs;

      const changed = Match.value(kind).pipe(
        Match.when("DeliveryRateDrop", () => {
          const sent = 200 * Math.ceil(sample.sent / 100);
          const edge = (ShipLimits.deliveryRateDropPoints * sent) / 100;
          const lost = edge + (Math.abs(delta) % 3) - 1;
          const clean = facts({ ...sample, acked, sent, undelivered: 0 });

          return {
            after: facts({ ...sample, acked, sent, undelivered: lost }),
            baseline: clean,
            crossed: lost > edge,
            health: okHealth,
          };
        }),
        Match.when("DeliveryLatencyRegression", () => ({
          after: facts({ ...sample, acked, p95: latencyEdge + delta }),
          baseline,
          crossed: delta > 0,
          health: okHealth,
        })),
        Match.when("ListenersMissing", () => ({
          after: baseline,
          baseline,
          crossed: delta > 0,
          health: {
            ...okHealth,
            listeners: { count: 10 - Math.max(0, delta), expected: 10 },
          },
        })),
        Match.when("HealthStatus", () => ({
          after: baseline,
          baseline,
          crossed: delta !== 0,
          health: {
            ...okHealth,
            status: statusFor(delta),
          },
        })),
        Match.exhaustive
      );

      const verdict = judgeShip({
        after: changed.after,
        baseline: changed.baseline,
        health: changed.health,
        sha,
      });

      expect(verdict._tag).toBe(changed.crossed ? "Fail" : "Pass");
      expect(verdict.reasons.map((reason) => reason._tag)).toEqual(
        changed.crossed ? [kind] : []
      );
    })
);

it.effect(
  "the land-watch incident passes: unacked mail that was delivered is recipient attention, not mailbox health",
  () =>
    Effect.sync(() => {
      const verdict = judgeShip({
        after: facts({ acked: 70, p95: 100, sent: 77, undelivered: 0 }),
        baseline: facts({ acked: 70, p95: 100, sent: 73, undelivered: 1 }),
        health: okHealth,
        sha: "d".repeat(40),
      });

      expect(verdict._tag).toBe("Pass");
      expect(verdict.reasons).toEqual([]);
    })
);

const Attention = Schema.Struct({
  afterAcked: Small(200),
  baselineAcked: Small(200),
  sent: Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 20 })),
});

it.effect.prop(
  "acks never decide a verdict when delivery is unchanged",
  [Attention],
  ([{ afterAcked, baselineAcked, sent }]) =>
    Effect.sync(() => {
      const verdict = judgeShip({
        after: facts({
          acked: Math.min(afterAcked, sent),
          p95: 100,
          sent,
          undelivered: 0,
        }),
        baseline: facts({
          acked: Math.min(baselineAcked, sent),
          p95: 100,
          sent,
          undelivered: 0,
        }),
        health: okHealth,
        sha: "d".repeat(40),
      });

      expect(verdict._tag).toBe("Pass");
    })
);

const Stranded = Schema.Struct({
  excess: Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 1 })),
  recipients: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
  sent: Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 20 })),
});

it.effect.prop(
  "a delivery drop over the limit fails only with enough undelivered mail across enough recipients, otherwise it is Unknown",
  [Stranded],
  ([{ excess, recipients, sent }]) =>
    Effect.sync(() => {
      const spread = Math.min(recipients, excess);

      const verdict = judgeShip({
        after: facts({
          acked: 0,
          p95: 100,
          recipients: spread,
          sent,
          undelivered: excess,
        }),
        baseline: facts({ acked: sent, p95: 100, sent, undelivered: 0 }),
        health: okHealth,
        sha: "e".repeat(40),
      });

      const expected = Match.value({ excess, spread }).pipe(
        Match.when(
          ({ excess: count }) => count < ShipLimits.evidenceFloor,
          () => ({ tag: "Unknown", why: "ThinEvidence" })
        ),
        Match.when(
          ({ spread: count }) => count < ShipLimits.distinctRecipients,
          () => ({ tag: "Unknown", why: "SingleRecipient" })
        ),
        Match.orElse(() => ({ tag: "Fail", why: "DeliveryRateDrop" }))
      );

      expect(verdict._tag).toBe(expected.tag);
      expect(verdict.reasons.map((reason) => reason._tag)).toEqual([
        expected.why,
      ]);

      if (expected.why === "SingleRecipient") {
        expect(verdict.reasons).toEqual([
          SingleRecipient.make({ count: excess, did: recipientDid(0) }),
        ]);
      }
    })
);

const Quiet = Schema.Struct({
  afterSent: Small(200),
  baselineSent: Small(200),
  health: Schema.Literals(["absent", "noListeners", "ok", "down"]),
});

it.effect.prop(
  "a quiet window or missing health is Unknown even when a failure is visible",
  [Quiet],
  ([{ afterSent, baselineSent, health }]) =>
    Effect.sync(() => {
      const gate: JudgeHealth | null = Match.value(health).pipe(
        Match.when("absent", () => null),
        Match.when("noListeners", () => ({
          listeners: null,
          status: "ok" as const,
        })),
        Match.when("ok", () => okHealth),
        Match.when("down", () => ({
          listeners: { count: 0, expected: 10 },
          status: "fail" as const,
        })),
        Match.exhaustive
      );

      const unknown =
        Math.min(afterSent, baselineSent) < ShipLimits.minimumSent ||
        gate === null ||
        gate.listeners === null;

      const verdict = judgeShip({
        after: facts({ acked: 0, p95: null, sent: afterSent, undelivered: 0 }),
        baseline: facts({
          acked: baselineSent,
          p95: 10,
          sent: baselineSent,
          undelivered: 0,
        }),
        health: gate,
        sha: "b".repeat(40),
      });

      if (unknown) {
        expect(verdict._tag).toBe("Unknown");
      } else {
        expect(verdict._tag).not.toBe("Unknown");
      }
    })
);

const shippedAt = Date.parse("2026-10-13T20:00:00.000Z");

const trafficFor = (
  mode: "good" | "dropThirdAck" | "dropThirdDelivery" | "slowDelivery",
  perWindow: number
) => {
  const windows = shipWindows(shippedAt, ShipLimits.windowMinutes);
  const gap = Math.floor(400_000 / perWindow);

  return [
    { bad: false, start: windows.baseline.start, tag: "base" },
    { bad: mode !== "good", start: windows.after.start, tag: "after" },
  ].flatMap(({ bad, start, tag }) =>
    Array.from({ length: perWindow }, (_, index) => {
      const id = `${tag}-${index}`;
      const at = start + index * gap;
      const delay = bad && mode === "slowDelivery" ? 1000 : 0;
      const third = bad && index % 3 === 2;
      const stranded = third && mode === "dropThirdDelivery";
      const unacked = stranded || (third && mode === "dropThirdAck");
      const to = recipientDid(index);

      return [
        event(id, "accepted", at, to),
        ...(stranded ? [] : [event(id, "delivered", at + 20 + delay, to)]),
        ...(unacked ? [] : [event(id, "acked", at + 40 + delay, to)]),
      ];
    }).flat()
  );
};

const noTags: readonly string[] = [];

const runCommand = (args: readonly string[]) =>
  Effect.gen(function* captured() {
    const output: string[] = [];

    const code = yield* shipJudgeCommand(args).pipe(
      Effect.provideService(Console.Console, {
        ...console,
        error: () => {},
        log: (...values: readonly unknown[]) => {
          output.push(values.join(" "));
        },
      })
    );

    return { code, output };
  });

it.effect.prop(
  "planted delivery breaks fail with their own tag, while a good ship and an ack-only break pass through the CLI contract",
  [
    Schema.Literals([
      "good",
      "dropThirdAck",
      "dropThirdDelivery",
      "slowDelivery",
    ]),
    Schema.Int.check(Schema.isBetween({ maximum: 80, minimum: 20 })),
  ],
  ([mode, perWindow]) =>
    Effect.gen(function* plantedShip() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const traffic = path.join(directory, "traffic.jsonl");
      const health = path.join(directory, "health.json");

      yield* fs.writeFileString(
        traffic,
        trafficFor(mode, perWindow)
          .map((line) => JSON.stringify({ ...line, ciphertextSize: 1439 }))
          .join("\n")
      );

      yield* fs.writeFileString(
        health,
        JSON.stringify({ ...okHealth, storage: { slots: { free: 9 } } })
      );

      yield* TestClock.setTime(shippedAt + 11 * 60_000);
      const sha = "c".repeat(40);

      const { code, output } = yield* runCommand([
        "--sha",
        sha,
        "--shipped-at",
        iso(shippedAt),
        "--input",
        traffic,
        "--health",
        health,
      ]);

      const verdict = yield* Schema.decodeEffect(
        Schema.fromJsonString(ShipVerdict)
      )(output.join(""));

      const expected = Match.value(mode).pipe(
        Match.when("good", () => ({ code: 0, tags: noTags })),
        Match.when("dropThirdAck", () => ({ code: 0, tags: noTags })),
        Match.when("dropThirdDelivery", () => ({
          code: 1,
          tags: ["DeliveryRateDrop"],
        })),
        Match.when("slowDelivery", () => ({
          code: 1,
          tags: ["DeliveryLatencyRegression"],
        })),
        Match.exhaustive
      );

      expect(code).toBe(expected.code);
      expect(verdict.sha).toBe(sha);
      expect(verdict._tag).toBe(code === 0 ? "Pass" : "Fail");
      expect(verdict.reasons.map((reason) => reason._tag)).toEqual(
        expected.tags
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 30 } }
);

it.effect.prop(
  "every refused input exits with the refusal code and prints no verdict, so no error can read as Fail",
  [
    Schema.Literals([
      "badSha",
      "badTime",
      "openWindow",
      "forbiddenLine",
      "missingInput",
      "malformedHealth",
      "missingHealth",
      "unknownFlag",
      "badRange",
      "zeroWindow",
      "lateBaseline",
    ]),
  ],
  ([mutation]) =>
    Effect.gen(function* refusal() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const traffic = path.join(directory, "traffic.jsonl");
      const health = path.join(directory, "health.json");
      const lines = trafficFor("good", 30);

      yield* fs.writeFileString(
        traffic,
        [
          ...lines.map((line) => JSON.stringify(line)),
          ...(mutation === "forbiddenLine"
            ? [JSON.stringify({ ...lines[0], body: "PRIVATE" })]
            : []),
        ].join("\n")
      );

      yield* fs.writeFileString(
        health,
        mutation === "malformedHealth" ? "{" : JSON.stringify(okHealth)
      );

      yield* TestClock.setTime(
        mutation === "openWindow" ? shippedAt + 60_000 : shippedAt + 3_600_000
      );

      const flags = new Map([
        [
          "--health",
          mutation === "missingHealth" ? path.join(directory, "none") : health,
        ],
        [
          "--input",
          mutation === "missingInput" ? path.join(directory, "gone") : traffic,
        ],
        ["--sha", mutation === "badSha" ? "HEAD" : "d".repeat(40)],
        [
          "--shipped-at",
          mutation === "badTime" ? "2026-10-13 20:00" : iso(shippedAt),
        ],
      ]);

      if (mutation === "lateBaseline") {
        flags.set("--baseline-end", iso(shippedAt + 1000));
      }

      if (mutation === "zeroWindow") {
        flags.set("--window-minutes", "0");
      }

      if (mutation === "unknownFlag") {
        flags.set("--force", "yes");
      }

      const args =
        mutation === "badRange"
          ? ["--revertible", "main..HEAD", "--repo", directory]
          : [...flags].flat();

      const { code, output } = yield* runCommand(args);

      expect(code).toBe(3);
      expect(output).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer))
);

const twoWayPaths = [
  "stacks/nest/usage.ts",
  "apps/mailbox/src/worker.ts",
  "README.md",
  "packages/alchemy-nest/src/celld.ts",
];

const oneWayPaths = [
  "lexicons/sh/mailbox/send.json",
  "apps/mailbox/src/bindings.ts",
  "apps/mailbox/src/sqlite.ts",
  "stacks/nest/migrations/0002-cursor.sql",
  "packages/store/src/migration-v3.ts",
];

it.effect.prop(
  "a ship is revertible only when no path is one-way and no commit carries a One-way trailer",
  [
    Schema.Array(Small(twoWayPaths.length - 1)),
    Schema.Array(Small(oneWayPaths.length - 1)),
    Schema.Array(Schema.Literal("e".repeat(40))),
  ],
  ([twoWay, oneWay, trailerCommits]) =>
    Effect.sync(() => {
      const touched = oneWay.map((index) => oneWayPaths[index] ?? "");

      const answer = classifyShip({
        oneWayCommits: trailerCommits,
        paths: [...twoWay.map((index) => twoWayPaths[index] ?? ""), ...touched],
      });

      if (touched.length === 0 && trailerCommits.length === 0) {
        expect(answer).toEqual(Revertible.make({}));
      } else {
        expect(answer).toEqual(
          OneWay.make({ commits: trailerCommits, paths: touched })
        );
      }
    })
);

const Step = Schema.Literals([
  "mergeTwoWay",
  "mergeLexicon",
  "mergeTrailer",
  "revertTip",
]);

interface MergeModel {
  readonly base: string;
  readonly oneWay: boolean;
  readonly sha: string;
}

const gitConfig = [
  "-c",
  "user.name=fixture",
  "-c",
  "user.email=fixture",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

it.effect.prop(
  "revertible answers follow a model of the tip merge across merges, one-way ships and reverts",
  [Schema.Array(Step).check(Schema.isMaxLength(5))],
  ([plan]) =>
    Effect.gen(function* gitModel() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const git = yield* gitIn(directory);
      const run = (args: readonly string[]) => git.run([...gitConfig, ...args]);

      yield* run(["init", "-q", "-b", "main"]);
      yield* fs.writeFileString(path.join(directory, "seed.ts"), "0\n");
      yield* run(["add", "seed.ts"]);
      yield* run(["commit", "-q", "-m", "seed"]);

      const merges: MergeModel[] = [];
      let tipMerge: MergeModel | null = null;

      for (const [index, step] of plan.entries()) {
        const head = (yield* run(["rev-parse", "HEAD"])).trim();

        if (step === "revertTip") {
          yield* run(
            tipMerge === null
              ? ["revert", "--no-edit", "HEAD"]
              : ["revert", "--no-edit", "-m", "1", "HEAD"]
          );
          tipMerge = null;
        } else {
          const branch = `lane-${index}`;

          const file =
            step === "mergeLexicon"
              ? `lexicons/l${index}.json`
              : `src/change-${index}.ts`;

          yield* run(["checkout", "-q", "-b", branch]);
          yield* fs.makeDirectory(path.join(directory, path.dirname(file)), {
            recursive: true,
          });
          yield* fs.writeFileString(path.join(directory, file), `${index}\n`);
          yield* run(["add", file]);

          yield* run([
            "commit",
            "-q",
            "-m",
            step === "mergeTrailer"
              ? `change ${index}\n\nOne-way: fixture storage contract`
              : `change ${index}`,
          ]);

          yield* run(["checkout", "-q", "main"]);
          yield* run([
            "merge",
            "-q",
            "--no-ff",
            "-m",
            `merge ${index}`,
            branch,
          ]);

          tipMerge = {
            base: head,
            oneWay: step !== "mergeTwoWay",
            sha: (yield* run(["rev-parse", "HEAD"])).trim(),
          };

          merges.push(tipMerge);
        }

        for (const merge of merges) {
          const answer = yield* revertibility(
            git,
            `${merge.base}..${merge.sha}`
          );

          if (merge === tipMerge) {
            expect(answer._tag).toBe(merge.oneWay ? "OneWay" : "Revertible");
          } else {
            expect(answer._tag).toBe("NotTipMerge");
          }
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 } }
);

const hookVariables = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_AUTHOR_NAME",
] as const;

it.effect.prop(
  "revertible git calls ignore hook GIT_* variables and leave the hook's repository untouched",
  [Schema.Array(Schema.Literals(hookVariables)).check(Schema.isMinLength(1))],
  ([exported]) =>
    Effect.gen(function* decoyRepository() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const decoy = yield* fs.makeTempDirectoryScoped();
      const fixture = yield* fs.makeTempDirectoryScoped();
      const decoyGit = yield* gitIn(decoy);

      const inDecoy = (args: readonly string[]) =>
        decoyGit.run([...gitConfig, ...args]);

      yield* inDecoy(["init", "-q", "-b", "main"]);
      yield* fs.writeFileString(path.join(decoy, "decoy.ts"), "decoy\n");
      yield* inDecoy(["add", "decoy.ts"]);
      yield* inDecoy(["commit", "-q", "-m", "decoy"]);

      const decoyHead = (yield* inDecoy(["rev-parse", "HEAD"])).trim();
      const decoyIndex = yield* fs.readFile(path.join(decoy, ".git/index"));

      const hookEnvironment = {
        GIT_AUTHOR_NAME: "hook",
        GIT_DIR: path.join(decoy, ".git"),
        GIT_INDEX_FILE: path.join(decoy, ".git/index"),
        GIT_WORK_TREE: decoy,
      };

      const saved = hookVariables.map((name) => [name, process.env[name]]);

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          for (const name of exported) {
            process.env[name] = hookEnvironment[name];
          }
        }),
        () =>
          Effect.sync(() => {
            for (const [name = "", value] of saved) {
              if (value === undefined) {
                Reflect.deleteProperty(process.env, name);
              } else {
                process.env[name] = value;
              }
            }
          })
      );

      const git = yield* gitIn(fixture);
      const run = (args: readonly string[]) => git.run([...gitConfig, ...args]);

      yield* run(["init", "-q", "-b", "main"]);
      yield* fs.writeFileString(path.join(fixture, "seed.ts"), "0\n");
      yield* run(["add", "seed.ts"]);
      yield* run(["commit", "-q", "-m", "seed"]);
      const base = (yield* run(["rev-parse", "HEAD"])).trim();
      yield* run(["checkout", "-q", "-b", "lane"]);
      yield* fs.writeFileString(path.join(fixture, "change.ts"), "1\n");
      yield* run(["add", "change.ts"]);
      yield* run(["commit", "-q", "-m", "change"]);
      yield* run(["checkout", "-q", "main"]);
      yield* run(["merge", "-q", "--no-ff", "-m", "merge", "lane"]);
      const sha = (yield* run(["rev-parse", "HEAD"])).trim();

      const answer = yield* revertibility(git, `${base}..${sha}`);

      expect(answer).toEqual(Revertible.make({}));
      expect((yield* inDecoy(["rev-parse", "HEAD"])).trim()).toBe(decoyHead);
      expect(yield* fs.readFile(path.join(decoy, ".git/index"))).toStrictEqual(
        decoyIndex
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 } }
);

it.effect.prop(
  "a wrong revert judged against the incident baseline still fails, while its own recent baseline hides the drop",
  [Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: 24 }))],
  ([perMinute]) =>
    Effect.gen(function* wrongRevert() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const traffic = path.join(directory, "traffic.jsonl");
      const health = path.join(directory, "health.json");
      const incident = shippedAt;
      const revert = incident + 5 * 60_000;
      const gap = Math.floor(60_000 / perMinute);

      const lines = Array.from({ length: 12 * perMinute }, (_, index) => {
        const at = incident - 3 * 60_000 + index * gap;
        const id = `m-${index}`;
        const dropped = at >= incident && index % 3 === 2;

        return [
          event(id, "accepted", at, recipientDid(index)),
          ...(dropped
            ? []
            : [
                event(id, "delivered", at + 20, recipientDid(index)),
                event(id, "acked", at + 40, recipientDid(index)),
              ]),
        ];
      }).flat();

      yield* fs.writeFileString(
        traffic,
        lines.map((line) => JSON.stringify(line)).join("\n")
      );

      yield* fs.writeFileString(health, JSON.stringify(okHealth));
      yield* TestClock.setTime(revert + 10 * 60_000);

      const judge = (extra: readonly string[]) =>
        runCommand([
          "--sha",
          "f".repeat(40),
          "--shipped-at",
          iso(revert),
          "--window-minutes",
          "3",
          "--input",
          traffic,
          "--health",
          health,
          ...extra,
        ]);

      const anchored = yield* judge(["--baseline-end", iso(incident)]);
      const recent = yield* judge([]);

      const decode = Schema.decodeEffect(Schema.fromJsonString(ShipVerdict));
      const failed = yield* decode(anchored.output.join(""));
      const hidden = yield* decode(recent.output.join(""));

      expect(anchored.code).toBe(1);
      expect(failed.reasons.map((reason) => reason._tag)).toEqual([
        "DeliveryRateDrop",
      ]);
      expect(hidden.reasons.map((reason) => reason._tag)).not.toContain(
        "DeliveryRateDrop"
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 15 } }
);
