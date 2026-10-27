import {
  Clock,
  Console,
  Effect,
  FileSystem,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Status } from "./health.ts";
import {
  classifyOneWay,
  fallbackPath,
  oneWayAnswer,
  oneWayExitCode,
  parseUnifiedDiff,
} from "./one-way.ts";
import type {
  Classification,
  CommitClassification,
  FileDiff,
  Finding,
} from "./one-way.ts";
import { FleetError as JudgeError } from "./stage-config.ts";
import { decodeTrafficLine, fileLines, usageWindow } from "./usage.ts";
import type { WindowBounds } from "./usage.ts";

export const ShipLimits = {
  deliveryRateDropPoints: 2,
  distinctRecipients: 2,
  evidenceFloor: 3,
  latencyFactor: 2,
  latencySlackMs: 250,
  minimumSent: 20,
  restartSkipMs: 60_000,
  windowMinutes: 10,
} as const;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Observed = Schema.NullOr(Schema.Union([Schema.Finite, Schema.String]));

const observation = <const Tag extends string>(tag: Tag) =>
  Schema.TaggedStruct(tag, { limit: Observed, value: Observed });

export const DeliveryRateDrop = observation("DeliveryRateDrop");

export const DeliveryLatencyRegression = observation(
  "DeliveryLatencyRegression"
);

export const ListenersMissing = observation("ListenersMissing");

export const HealthStatus = observation("HealthStatus");

export const InsufficientTraffic = observation("InsufficientTraffic");

export const HealthMissing = observation("HealthMissing");

export const ThinEvidence = observation("ThinEvidence");

export const SingleRecipient = Schema.TaggedStruct("SingleRecipient", {
  count: Count,
  did: Schema.String,
});

export const ShipReason = Schema.Union([
  DeliveryRateDrop,
  DeliveryLatencyRegression,
  ListenersMissing,
  HealthStatus,
  InsufficientTraffic,
  HealthMissing,
  ThinEvidence,
  SingleRecipient,
]);

export type Reason = typeof ShipReason.Type;

export const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

export const ShipHealth = Schema.Struct({
  listeners: Schema.NullOr(Schema.Struct({ count: Count, expected: Count })),
  reasons: Schema.optional(Schema.Array(Schema.String)),
  status: Status,
});

export type JudgeHealth = typeof ShipHealth.Type;

const Latency = Schema.Struct({
  p50: Schema.NullOr(Schema.Finite),
  p95: Schema.NullOr(Schema.Finite),
});

export const ShipWindow = Schema.Struct({
  ackLatency: Latency,
  acked: Count,
  delivered: Count,
  deliveryLatency: Latency,
  end: Schema.String,
  readerless: Schema.optional(Count),
  replays: Count,
  sent: Count,
  start: Schema.String,
  undelivered: Count,
  undeliveredRecipients: Schema.Array(
    Schema.Struct({ count: Count, did: Schema.String })
  ),
});

export type WindowFacts = typeof ShipWindow.Type;

const verdictFields = {
  after: ShipWindow,
  baseline: ShipWindow,
  readerless: Count,
  reasons: Schema.Array(ShipReason),
  sha: Sha,
};

export const Pass = Schema.TaggedStruct("Pass", verdictFields);

export const Fail = Schema.TaggedStruct("Fail", verdictFields);

export const Unknown = Schema.TaggedStruct("Unknown", verdictFields);

export const ShipVerdict = Schema.Union([Pass, Fail, Unknown]);

export type Verdict = typeof ShipVerdict.Type;

export const verdictExitCode = { Fail: 1, Pass: 0, Unknown: 2 } as const;

export const refusalExitCode = 3;

export const Refused = Schema.TaggedStruct("Refused", {
  error: Schema.String,
  reason: Schema.NullOr(Schema.String),
});

export const shipWindows = (
  shippedAt: number,
  windowMinutes: number,
  baselineEnd = shippedAt
) => {
  const span = windowMinutes * 60_000;
  const after = shippedAt + ShipLimits.restartSkipMs;

  return {
    after: { end: after + span, start: after },
    baseline: { end: baselineEnd, start: baselineEnd - span },
  } satisfies Record<string, WindowBounds>;
};

const deliveryReasons = (baseline: WindowFacts, after: WindowFacts) => {
  const failures: Reason[] = [];
  const unknowns: Reason[] = [];

  const lostPoints =
    100 *
    (after.undelivered * baseline.sent - baseline.undelivered * after.sent);

  const scale = baseline.sent * after.sent;
  const excess = after.undelivered - baseline.undelivered;
  const [top] = after.undeliveredRecipients;

  if (lostPoints > ShipLimits.deliveryRateDropPoints * scale) {
    if (excess < ShipLimits.evidenceFloor) {
      unknowns.push(
        ThinEvidence.make({ limit: ShipLimits.evidenceFloor, value: excess })
      );
    } else if (
      after.undeliveredRecipients.length < ShipLimits.distinctRecipients &&
      top !== undefined
    ) {
      unknowns.push(SingleRecipient.make({ count: top.count, did: top.did }));
    } else {
      failures.push(
        DeliveryRateDrop.make({
          limit: ShipLimits.deliveryRateDropPoints,
          value: lostPoints / scale,
        })
      );
    }
  }

  const before = baseline.deliveryLatency.p95;
  const now = after.deliveryLatency.p95;

  if (before !== null && now !== null) {
    const limit = ShipLimits.latencyFactor * before + ShipLimits.latencySlackMs;

    if (now > limit) {
      failures.push(DeliveryLatencyRegression.make({ limit, value: now }));
    }
  }

  return { failures, unknowns };
};

export const restartReason = "celld started since the last digest";

const statusRank = { fail: 2, ok: 0, warn: 1 } as const;

const reasonKey = (reason: string) => reason.replaceAll(/\d+/gu, "#");

const statusWorsened = (
  health: JudgeHealth,
  prior: JudgeHealth | null,
  restarted: boolean
) => {
  if (health.status === "ok") {
    return false;
  }

  if (
    prior === null ||
    prior.reasons === undefined ||
    health.reasons === undefined
  ) {
    return statusRank[health.status] > statusRank[prior?.status ?? "ok"];
  }

  const known = new Set([
    ...prior.reasons.map(reasonKey),
    ...(restarted ? [reasonKey(restartReason)] : []),
  ]);

  return health.reasons.some((reason) => !known.has(reasonKey(reason)));
};

const healthReasons = (
  health: JudgeHealth,
  prior: JudgeHealth | null,
  restarted: boolean
) => [
  ...(health.listeners !== null &&
  health.listeners.count < health.listeners.expected
    ? [
        ListenersMissing.make({
          limit: health.listeners.expected,
          value: health.listeners.count,
        }),
      ]
    : []),
  ...(statusWorsened(health, prior, restarted)
    ? [HealthStatus.make({ limit: "ok", value: health.status })]
    : []),
];

export const judgeShip = (input: {
  readonly after: WindowFacts;
  readonly baseline: WindowFacts;
  readonly health: JudgeHealth | null;
  readonly prior?: JudgeHealth | null;
  readonly restarted?: boolean;
  readonly sha: string;
}): Verdict => {
  const { after, baseline, health, sha } = input;
  const prior = input.prior ?? null;
  const restarted = input.restarted ?? false;
  const quietest = Math.min(baseline.sent, after.sent);
  const judgeable = quietest >= ShipLimits.minimumSent;

  const delivery = judgeable
    ? deliveryReasons(baseline, after)
    : { failures: [], unknowns: [] };

  const unknownCauses = [
    ...(judgeable
      ? []
      : [
          InsufficientTraffic.make({
            limit: ShipLimits.minimumSent,
            value: quietest,
          }),
        ]),
    ...(health === null || health.listeners === null
      ? [HealthMissing.make({ limit: null, value: null })]
      : []),
    ...delivery.unknowns,
  ];

  const failures = [
    ...delivery.failures,
    ...(health === null ? [] : healthReasons(health, prior, restarted)),
  ];

  const fields = {
    after,
    baseline,
    readerless: after.readerless ?? 0,
    reasons: [...unknownCauses, ...failures],
    sha,
  };

  if (unknownCauses.length > 0) {
    return Unknown.make(fields);
  }

  return failures.length > 0 ? Fail.make(fields) : Pass.make(fields);
};

export const OneWayPaths = [
  { label: "lexicon", test: (path: string) => path.startsWith("lexicons/") },
  {
    label: "migration",
    test: (path: string) =>
      /(?:^|\/)[^/]*migrations?(?:\/|[^/]*$)/iu.test(path),
  },
  {
    label: "durable-object-migrations",
    test: (path: string) => path === "apps/mailbox/src/bindings.ts",
  },
  {
    label: "durable-object-schema",
    test: (path: string) => path === "apps/mailbox/src/sqlite.ts",
  },
] as const;

export const Revertible = Schema.TaggedStruct("Revertible", {});

export const OneWay = Schema.TaggedStruct("OneWay", {
  commits: Schema.Array(Sha),
  paths: Schema.Array(Schema.String),
});

export const NotTipMerge = Schema.TaggedStruct("NotTipMerge", {
  sha: Sha,
  tip: Schema.String,
});

export const Revertibility = Schema.Union([Revertible, OneWay, NotTipMerge]);

export const classifyShip = (input: {
  readonly findings?: readonly Finding[];
  readonly oneWayCommits: readonly string[];
  readonly paths: readonly string[];
}) => {
  const paths =
    input.findings === undefined
      ? input.paths.filter((path) =>
          OneWayPaths.some((rule) => rule.test(path))
        )
      : [...new Set(input.findings.map((finding) => finding.path))];

  return paths.length === 0 && input.oneWayCommits.length === 0
    ? Revertible.make({})
    : OneWay.make({ commits: [...input.oneWayCommits], paths });
};

export interface Git {
  readonly run: (args: readonly string[]) => Effect.Effect<string, JudgeError>;
}

const nonEmptyLines = (text: string) =>
  text.split("\n").filter((line) => line.length > 0);

const resolveCommit = (git: Git, ref: string) =>
  git
    .run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
    .pipe(Effect.map((out) => out.trim()));

const oneWayRange = Effect.fn("ShipJudge.oneWayRange")(function* oneWayRange(
  git: Git,
  range: string
) {
  const match =
    /^(?<base>[A-Za-z0-9_][A-Za-z0-9_./~^-]*)\.\.(?<head>[A-Za-z0-9_][A-Za-z0-9_./~^-]*)$/u.exec(
      range
    );

  const baseRef = match?.groups?.base;
  const headRef = match?.groups?.head;

  if (baseRef === undefined || headRef === undefined) {
    return yield* new JudgeError({ reason: "Expected <base>..<sha>" });
  }

  const base = yield* resolveCommit(git, baseRef);
  const head = yield* resolveCommit(git, headRef);
  const ancestor = (yield* git.run(["merge-base", base, head])).trim();

  if (ancestor !== base) {
    return yield* new JudgeError({
      reason: "Base must be an ancestor of head",
    });
  }

  return { base, head };
});

const diffClassification = Effect.fn("ShipJudge.diffClassification")(
  function* diffClassification(git: Git, base: string, head: string) {
    const range = `${base}..${head}`;

    const text = yield* git.run([
      "-c",
      "core.quotePath=true",
      "diff",
      "-U0",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      range,
      "--",
    ]);

    const parsed = yield* Effect.try({
      catch: () => new JudgeError({ reason: "Malformed unified diff" }),
      try: () => parseUnifiedDiff(text),
    });

    const paths = (yield* git.run([
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      range,
      "--",
    ]))
      .split("\0")
      .filter((path) => path.length > 0);

    const files: FileDiff[] = [];

    for (const file of parsed) {
      if (/^lexicons\/.*\.json$/u.test(file.path)) {
        files.push({
          ...file,
          after:
            file.newPath === null
              ? null
              : yield* git.run(["show", `${head}:${file.newPath}`]),
          before:
            file.oldPath === null
              ? null
              : yield* git.run(["show", `${base}:${file.oldPath}`]),
        });
      } else {
        files.push(file);
      }
    }

    const classified = classifyOneWay(files);

    const unseen: Finding[] = paths
      .filter(
        (path) =>
          fallbackPath(path) && !parsed.some((file) => file.path === path)
      )
      .map((path) => ({
        detail: "unparsed contract or storage diff",
        kind: "path",
        path,
      }));

    return {
      findings: [...classified.findings, ...unseen],
      info: classified.info,
    } satisfies Classification;
  }
);

const trailerFor = (git: Git, sha: string) =>
  git
    .run([
      "show",
      "-s",
      "--format=%(trailers:key=One-way,valueonly,separator=%x3B,unfold)",
      sha,
    ])
    .pipe(Effect.map((out) => out.trim()));

const declaredClassification = (
  classification: Classification,
  trailer: string
): Classification => ({
  findings:
    trailer.length === 0
      ? classification.findings
      : [
          ...classification.findings,
          { detail: "explicit One-way trailer", kind: "path", path: "" },
        ],
  info: classification.info,
});

export const inspectOneWay = Effect.fn("ShipJudge.inspectOneWay")(
  function* inspectOneWay(git: Git, range: string) {
    const { base, head } = yield* oneWayRange(git, range);
    const mergeTrailer = yield* trailerFor(git, head);

    const aggregate = declaredClassification(
      yield* diffClassification(git, base, head),
      mergeTrailer
    );

    const commits: CommitClassification[] = [];

    const revisions = nonEmptyLines(
      yield* git.run(["rev-list", "--no-merges", `${base}..${head}`])
    );

    for (const sha of revisions) {
      const parent = yield* resolveCommit(git, `${sha}^`);
      const trailer = yield* trailerFor(git, sha);
      commits.push({
        ...declaredClassification(
          yield* diffClassification(git, parent, sha),
          trailer
        ),
        sha,
        trailer,
      });
    }

    return { answer: oneWayAnswer(aggregate, commits, mergeTrailer), commits };
  }
);

export const revertibility = Effect.fn("ShipJudge.revertibility")(
  function* revertibility(git: Git, range: string) {
    const match = /^(?<base>[^.\s]+)\.\.(?<sha>[0-9a-f]{40})$/u.exec(range);
    const base = match?.groups?.base;
    const sha = match?.groups?.sha;

    if (base === undefined || sha === undefined) {
      return yield* new JudgeError({
        reason: "Expected --revertible <base>..<40-hex sha>",
      });
    }

    const tip = yield* resolveCommit(git, "HEAD");

    const [, firstParent, ...otherParents] = (yield* git.run([
      "rev-list",
      "--parents",
      "-n",
      "1",
      sha,
    ]))
      .trim()
      .split(" ");

    if (
      tip !== sha ||
      otherParents.length === 0 ||
      firstParent !== (yield* resolveCommit(git, base))
    ) {
      return NotTipMerge.make({ sha, tip });
    }

    const inspection = yield* inspectOneWay(git, `${firstParent}..${sha}`);

    return classifyShip({
      findings: Predicate.isTagged(inspection.answer, "OneWay")
        ? inspection.answer.findings
        : [],
      oneWayCommits: inspection.commits
        .filter(
          (commit) =>
            commit.findings.length > 0 || commit.trailer.trim().length > 0
        )
        .map((commit) => commit.sha),
      paths: [],
    });
  }
);

const oneWayReplay = Effect.fn("ShipJudge.oneWayReplay")(function* oneWayReplay(
  git: Git,
  last: string
) {
  if (!/^[1-9]\d?$/u.test(last)) {
    return yield* new JudgeError({
      reason: "Expected --last between 1 and 99",
    });
  }

  const main = yield* resolveCommit(git, "main");

  const merges = nonEmptyLines(
    yield* git.run([
      "rev-list",
      "--first-parent",
      "--merges",
      `--max-count=${last}`,
      main,
    ])
  );

  for (const sha of merges) {
    const parent = yield* resolveCommit(git, `${sha}^1`);
    const { answer } = yield* inspectOneWay(git, `${parent}..${sha}`);

    const label = Predicate.isTagged(answer, "OneWay")
      ? `OneWay ${answer.staged ? "staged" : "UNSTAGED"}`
      : "TwoWay";

    const kinds = Predicate.isTagged(answer, "OneWay")
      ? [...new Set(answer.findings.map((finding) => finding.kind))]
          .toSorted((left, right) => left.localeCompare(right))
          .join(",")
      : "";

    yield* Console.log(`${sha.slice(0, 12)} ${label} ${kinds}`.trim());
  }

  return 0;
});

export const repositoryEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
) =>
  Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith("GIT_"))
  );

export const gitIn = Effect.fn("ShipJudge.gitIn")(function* gitIn(
  directory: string
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = repositoryEnvironment(process.env);

  return {
    run: (args) =>
      Effect.gen(function* runGit() {
        const [out, code] = yield* Effect.scoped(
          Effect.gen(function* spawnGit() {
            const handle = yield* spawner.spawn(
              ChildProcess.make("git", ["-C", directory, ...args], {
                env,
                extendEnv: false,
                stdin: "ignore",
              })
            );

            return yield* Effect.all(
              [
                handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
                handle.exitCode,
                Stream.runDrain(handle.stderr),
              ],
              { concurrency: "unbounded" }
            );
          })
        ).pipe(
          Effect.mapError(() => new JudgeError({ reason: "git did not run" }))
        );

        if (code !== 0) {
          return yield* new JudgeError({
            reason: `git ${args[0] ?? ""} exited ${code}`,
          });
        }

        return out;
      }),
  } satisfies Git;
});

const usageText =
  "Usage: ship-judge --sha <40hex> --shipped-at <ISO> --input <traffic.jsonl> [--window-minutes 10] [--baseline-end <ISO>] [--health <health.json>] [--pre-health <health.json>] [--restarted true|false] | ship-judge --revertible <base>..<sha> [--repo <dir>] | ship-judge --one-way <base>..<sha> [--repo <dir>] | ship-judge --one-way-replay --last 30 [--repo <dir>]";

const parseFlags = (args: readonly string[], known: readonly string[]) => {
  const flags = new Map<string, string>();

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (
      flag === undefined ||
      !known.includes(flag) ||
      value === undefined ||
      value.startsWith("--") ||
      flags.has(flag)
    ) {
      return null;
    }

    flags.set(flag, value);
  }

  return flags;
};

const oneWayCommand = Effect.fn("ShipJudge.oneWayCommand")(
  function* oneWayCommand(args: readonly string[]) {
    if (args.includes("--one-way-replay")) {
      const flags = parseFlags(
        args.filter((arg) => arg !== "--one-way-replay"),
        ["--last", "--repo"]
      );

      const last = flags?.get("--last");

      if (
        flags === null ||
        last === undefined ||
        args.filter((arg) => arg === "--one-way-replay").length !== 1
      ) {
        return yield* new JudgeError({ reason: usageText });
      }

      return yield* oneWayReplay(
        yield* gitIn(flags.get("--repo") ?? "."),
        last
      );
    }

    const flags = parseFlags(args, ["--one-way", "--repo"]);
    const range = flags?.get("--one-way");

    if (flags === null || range === undefined) {
      return yield* new JudgeError({ reason: usageText });
    }

    const { answer } = yield* inspectOneWay(
      yield* gitIn(flags.get("--repo") ?? "."),
      range
    );

    yield* Console.log(JSON.stringify(answer));

    return oneWayExitCode(answer);
  }
);

const Instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u)
);

const WindowMinutes = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 120, minimum: 1 })
);

const judgeVerdict = Effect.fn("ShipJudge.verdict")(function* judgeVerdict(
  flags: ReadonlyMap<string, string>
) {
  const sha = yield* Schema.decodeUnknownEffect(Sha)(flags.get("--sha"));

  const shipped = yield* Schema.decodeUnknownEffect(Instant)(
    flags.get("--shipped-at")
  );

  const baselineEnd = yield* Schema.decodeUnknownEffect(Instant)(
    flags.get("--baseline-end") ?? shipped
  );

  const input = flags.get("--input");
  const shippedAt = Date.parse(shipped);
  const incidentBaseline = Date.parse(baselineEnd);

  const minutes = yield* Schema.decodeEffect(WindowMinutes)(
    flags.get("--window-minutes") ?? `${ShipLimits.windowMinutes}`
  );

  if (
    input === undefined ||
    !Number.isFinite(shippedAt) ||
    !Number.isFinite(incidentBaseline)
  ) {
    return yield* new JudgeError({ reason: usageText });
  }

  if (incidentBaseline > shippedAt) {
    return yield* new JudgeError({
      reason: "Baseline must end at or before the ship",
    });
  }

  const windows = shipWindows(shippedAt, minutes, incidentBaseline);

  if ((yield* Clock.currentTimeMillis) < windows.after.end) {
    return yield* new JudgeError({ reason: "After window is still open" });
  }

  const fs = yield* FileSystem.FileSystem;

  const readHealth = (path: string | undefined) =>
    path === undefined
      ? Effect.succeed(null)
      : fs
          .readFileString(path)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(ShipHealth))
            )
          );

  const health = yield* readHealth(flags.get("--health"));
  const prior = yield* readHealth(flags.get("--pre-health"));

  const restarted = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["true", "false"])
  )(flags.get("--restarted") ?? "false");

  const window = (bounds: WindowBounds) =>
    usageWindow(
      bounds,
      fileLines(fs, input).pipe(Stream.mapEffect(decodeTrafficLine))
    );

  return judgeShip({
    after: yield* window(windows.after),
    baseline: yield* window(windows.baseline),
    health,
    prior,
    restarted: restarted === "true",
    sha,
  });
});

const refuse = (error: string, reason: string | null) =>
  Console.error(JSON.stringify(Refused.make({ error, reason }))).pipe(
    Effect.as(refusalExitCode)
  );

export const shipJudgeCommand = (args: readonly string[]) =>
  Effect.gen(function* shipJudge() {
    if (args.includes("--one-way") || args.includes("--one-way-replay")) {
      return yield* oneWayCommand(args);
    }

    if (args.includes("--revertible")) {
      const flags = parseFlags(args, ["--revertible", "--repo"]);
      const range = flags?.get("--revertible");

      if (flags === null || range === undefined) {
        return yield* new JudgeError({ reason: usageText });
      }

      const answer = yield* revertibility(
        yield* gitIn(flags.get("--repo") ?? "."),
        range
      );

      yield* Console.log(JSON.stringify(answer));

      return Schema.is(Revertible)(answer) ? 0 : 1;
    }

    const flags = parseFlags(args, [
      "--sha",
      "--shipped-at",
      "--baseline-end",
      "--input",
      "--window-minutes",
      "--health",
      "--pre-health",
      "--restarted",
    ]);

    if (flags === null) {
      return yield* new JudgeError({ reason: usageText });
    }

    const verdict = yield* judgeVerdict(flags);
    yield* Console.log(JSON.stringify(verdict));

    return verdictExitCode[verdict._tag];
  }).pipe(
    Effect.catchTags({
      FleetError: ({ reason }) => refuse("FleetError", reason),
      ForbiddenField: ({ field }) => refuse("ForbiddenField", field),
      PlatformError: () => refuse("PlatformError", null),
      SchemaError: () => refuse("SchemaError", null),
    })
  );
