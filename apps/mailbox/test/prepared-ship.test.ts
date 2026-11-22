import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import type { Path } from "effect";
import {
  Clock,
  Effect,
  FileSystem,
  Option,
  Schema,
  Sink,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";
import { initialTransition } from "xstate";

import { digest } from "../../../packages/alchemy-nest/src/files.ts";
import { ReleaseSource } from "../../../packages/alchemy-nest/src/release.ts";
import {
  deploymentReleaseSource,
  preparedDeployment,
} from "../../../stacks/nest/deploy-payloads.ts";
import { mailboxManifest } from "../../../stacks/nest/prepared-manifest.ts";
import { encodePrepared } from "../../../stacks/nest/prepared-payload.ts";
import type {
  ShipCheckpoint,
  ShipReceipt,
} from "../../../stacks/nest/ship-config.ts";
import {
  durableGithubBudget,
  githubBudget,
} from "../../../stacks/nest/ship-github-budget.ts";
import { shipMachine } from "../../../stacks/nest/ship-machine.ts";
import { preparedEvidence } from "../../../stacks/nest/ship-prepared-evidence.ts";
import { selectPrepared } from "../../../stacks/nest/ship-select.ts";
import { shipCycle } from "../../../stacks/nest/ship.ts";

const checkpoint = "1".repeat(40);

const before = "2".repeat(40);

const eligible = "3".repeat(40);

const head = "4".repeat(40);

const unrelated = "5".repeat(40);

const repository = "example/project";

const Case = Schema.Literals([
  "ready",
  "apply-failed",
  "pin-mismatch",
  "new-binding",
  "unknown-manifest-field",
  "candidate-date",
  "embedded-sha-mismatch",
  "invalid-format",
  "invalid-length",
  "payload-symlink",
  "list-symlink",
  "not-main",
  "absent-checkpoint",
  "behind-checkpoint",
  "wrong-branch",
  "wrong-event",
  "wrong-workflow",
  "pending-fence",
  "overdue-fence",
  "pending-head",
  "paginated-jobs",
  "non-tip",
  "skipped-fence-job",
  "wrong-fence-sha",
]);

type Scenario = typeof Case.Type;

const programs = {
  backup: "throw new Error('backup executed locally')",
  cli: "throw new Error('CLI executed locally')",
  manifest: mailboxManifest,
  restart: "throw new Error('restart gate executed locally')",
  worker: "throw new Error('worker executed locally')",
};

const run = (sha: string, scenario: Scenario) => ({
  conclusion: "success",
  event: scenario === "wrong-event" ? "pull_request" : "push",
  head_branch: scenario === "wrong-branch" ? "test" : "main",
  head_sha: scenario === "wrong-fence-sha" ? unrelated : sha,
  id: 10,
  path:
    scenario === "wrong-workflow"
      ? ".github/workflows/another.yml"
      : ".github/workflows/fence.yml",
  run_attempt: 1,
  run_started_at:
    scenario === "overdue-fence" ? "1969-12-31T23:00:00Z" : undefined,
  status:
    scenario === "pending-fence" || scenario === "overdue-fence" || sha === head
      ? "in_progress"
      : "completed",
});

const client = (scenario: Scenario) =>
  HttpClient.make((request) => {
    const prefix = `https://api.github.com/repos/${repository}/`;
    const url = request.url.slice(prefix.length);
    expect(request.url.startsWith(prefix)).toBe(true);
    expect(request.method).toBe("GET");

    if (url === "git/ref/heads/main") {
      const response =
        request.headers["if-none-match"] === '"fixture-ref"'
          ? new Response(null, { status: 304 })
          : Response.json(
              { object: { sha: head, type: "commit" }, ref: "refs/heads/main" },
              { headers: { ETag: '"fixture-ref"' } }
            );

      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }

    if (url.startsWith("git/commits/")) {
      const sha = url.slice("git/commits/".length);

      const parents = new Map([
        [
          head,
          scenario === "not-main"
            ? [checkpoint, eligible]
            : [eligible, unrelated],
        ],
        [eligible, [checkpoint]],
        [checkpoint, [before]],
        [before, []],
      ]);

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            parents: parents.get(sha)?.map((parent) => ({ sha: parent })),
            sha,
          })
        )
      );
    }

    if (
      scenario === "paginated-jobs" &&
      url === "actions/runs/10/attempts/1/jobs?per_page=100"
    ) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            { jobs: [] },
            { headers: { Link: '<https://example.invalid/next>; rel="next"' } }
          )
        )
      );
    }

    if (
      url === "actions/runs/10/attempts/1/jobs?per_page=100" ||
      (scenario === "paginated-jobs" &&
        url === "actions/runs/10/attempts/1/jobs?per_page=100&page=2")
    ) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            jobs: [
              {
                conclusion:
                  scenario === "skipped-fence-job" ? "skipped" : "success",
                head_sha: eligible,
                name: "fence",
                status: "completed",
              },
            ],
          })
        )
      );
    }

    const sha =
      url.includes(`head_sha=${head}`) && scenario === "pending-head"
        ? head
        : eligible;

    expect(url).toBe(
      `actions/workflows/fence.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=1`
    );

    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          workflow_runs: scenario === "non-tip" ? [] : [run(sha, scenario)],
        })
      )
    );
  });

const spawner = (helper: string, replies: ReadonlyMap<string, string>) =>
  ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) {
      return Effect.die("No pipeline may run on the trusted side");
    }

    expect(command.command).toBe(helper);
    expect(command.options.extendEnv).toBe(false);
    expect(command.options.env).toEqual({});

    const args = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
      command.args
    );

    const output = replies.get(args.join(" "));

    if (output === undefined) {
      return Effect.die("Only the three approved helper calls may run");
    }

    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(1),
        stderr: Stream.empty,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(output)),
        unref: Effect.succeed(Effect.void),
      })
    );
  });

const fixture = Effect.fn("PreparedShip.fixture")(function* fixture(
  scenario: Scenario
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const list = `${root}/first-parent`;
  const snapshot = `${root}/${eligible}.bundle`;
  const helper = `${root}/verified-artifact`;

  const encoded = encodePrepared({
    ...programs,
    commit: scenario === "embedded-sha-mismatch" ? unrelated : eligible,
    manifest: {
      ...mailboxManifest,
      declaration: {
        ...mailboxManifest.declaration,
        compatibility_date:
          scenario === "candidate-date"
            ? "2026-11-10"
            : mailboxManifest.declaration.compatibility_date,
        durable_objects: {
          bindings:
            scenario === "new-binding"
              ? [
                  ...mailboxManifest.declaration.durable_objects.bindings,
                  { class_name: "Mailbox", name: "EXTRA" },
                ]
              : mailboxManifest.declaration.durable_objects.bindings,
        },
      },
    },
    version: "1.2.3",
  });

  const serialized = new TextDecoder().decode(encoded);
  const tampered = serialized.replace("rat-king/fleet/v2", "rat-king/fleet/v1");
  const wrongLength = serialized.replace(/"bytes":\d+/u, '"bytes":1');

  const variants = new Map<Scenario, string>([
    ["invalid-format", tampered],
    ["invalid-length", wrongLength],
    [
      "unknown-manifest-field",
      serialized.replace('"manifest":{', '"manifest":{"unexpected":true,'),
    ],
  ]);

  const bytes = new TextEncoder().encode(variants.get(scenario) ?? serialized);

  const pin = scenario === "pin-mismatch" ? "0".repeat(64) : digest(bytes);

  const rows =
    scenario === "behind-checkpoint"
      ? `${before}\n${checkpoint}\n`
      : `${before}\n${unrelated}\n${eligible}\n${head}\n`;

  const listWrite = scenario === "list-symlink" ? `${list}.source` : list;

  const snapshotWrite =
    scenario === "payload-symlink" ? `${snapshot}.source` : snapshot;

  yield* fs.writeFileString(listWrite, rows);
  yield* fs.writeFile(snapshotWrite, bytes);

  if (list !== listWrite) {
    yield* fs.symlink(listWrite, list);
  }

  if (snapshot !== snapshotWrite) {
    yield* fs.symlink(snapshotWrite, snapshot);
  }

  return {
    evidence: preparedEvidence(
      repository,
      ["--candidate-file", list, "--artifact-helper", helper],
      root
    ),
    programs: spawner(
      helper,
      new Map([
        [
          "--eligible",
          `${before}\n${unrelated}\n${eligible}\n${scenario === "pending-head" ? `${head}\n` : ""}`,
        ],
        [`--pin ${eligible}`, `${pin}\n`],
        [eligible, `${snapshot}\n`],
      ])
    ),
  };
});

const malformed = [
  eligible,
  "Prepared ship evidence unavailable or malformed",
] as const;

const manifestChange = [eligible, "ManifestChange: needs legacy ship"] as const;

const bundleFormat = [eligible, "BundleFormat"] as const;

const reasonByCase: Record<Scenario, readonly [string, string] | undefined> = {
  "absent-checkpoint": ["", "CheckpointNotFirstParent"],
  "apply-failed": undefined,
  "behind-checkpoint": undefined,
  "candidate-date": undefined,
  "embedded-sha-mismatch": bundleFormat,
  "invalid-format": bundleFormat,
  "invalid-length": bundleFormat,
  "list-symlink": ["", "Prepared ship evidence unavailable or malformed"],
  "new-binding": manifestChange,
  "non-tip": [eligible, "NotPushTip"],
  "not-main": undefined,
  "overdue-fence": [eligible, "ExactFencePendingOverdue"],
  "paginated-jobs": undefined,
  "payload-symlink": [eligible, "ArtifactMissingOrUnreadable"],
  "pending-fence": [eligible, "ExactFencePending"],
  "pending-head": [head, "ExactFencePending"],
  "pin-mismatch": [eligible, "Prepared fleet bundle pin mismatch"],
  ready: undefined,
  "skipped-fence-job": [eligible, "ExactFenceNotGreen"],
  "unknown-manifest-field": manifestChange,
  "wrong-branch": malformed,
  "wrong-event": malformed,
  "wrong-fence-sha": malformed,
  "wrong-workflow": malformed,
};

const checkPrepared = (scenario: Scenario) =>
  Effect.gen(function* runScenario() {
    const { evidence, programs: commands } = yield* fixture(scenario);
    const liveSha = scenario === "absent-checkpoint" ? unrelated : checkpoint;

    const [initial] = initialTransition(shipMachine, {
      failed: "",
      preparedRetries:
        scenario === "apply-failed" ? { [head]: Number.MAX_SAFE_INTEGER } : {},
      successful: liveSha,
    });

    const checkpoints: (typeof ShipCheckpoint.Type)[] = [];
    const receipts: (typeof ShipReceipt.Type)[] = [];
    const holds = new Map<string, string>();
    let recoveries = 0;

    const cycle = yield* shipCycle<
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | HttpClient.HttpClient
    >(initial, {
      checkpoint: (state) =>
        Effect.sync(() => {
          checkpoints.push(state);
        }),
      deployPrepared: Effect.fn("Fixture.apply")(function* apply(payload) {
        expect(checkpoints).toHaveLength(1);
        expect(checkpoints[0]?.failed).toBe(payload.commit);

        const stage = yield* preparedDeployment(payload, {
          SERVICE_DID: "fixture",
        });

        const download = yield* Effect.gen(function* attemptDownload() {
          const releases = yield* ReleaseSource;

          return yield* releases.get({
            size: 1,
            url: "https://example.invalid/asset",
          });
        }).pipe(Effect.provide(deploymentReleaseSource(payload)), Effect.flip);

        expect(download.reason).toContain("already-pinned host binaries");

        expect(stage.backup).toBe(programs.backup);
        expect(stage.cli).toBe(programs.cli);
        expect(stage.restart).toBe(programs.restart);
        expect(stage.deployment.bundle).toBe(programs.worker);
        expect(stage.deployment.configuration).toContain(
          '"vars":{"SERVICE_DID":"fixture"}'
        );

        if (scenario === "candidate-date") {
          expect(stage.deployment.configuration).toContain(
            '"compatibility_date":"2026-11-10"'
          );
        }

        return {
          celldRestarted: false,
          restartSeconds: 0,
          result:
            scenario === "apply-failed"
              ? ("failed" as const)
              : ("success" as const),
        };
      }, Effect.orDie),
      notify: () => Effect.void,
      record: (receipt) =>
        Effect.sync(() => {
          receipts.push(receipt);
        }),
      recover: Effect.sync(() => {
        recoveries += 1;

        return "recovered" as const;
      }),
      select: (saved, now) =>
        selectPrepared<
          ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
        >(evidence, saved, now, (sha, reason) => {
          holds.set(sha, reason);
        }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commands),
      Effect.provideService(HttpClient.HttpClient, client(scenario))
    );

    const success =
      scenario === "ready" ||
      scenario === "pending-head" ||
      scenario === "candidate-date" ||
      scenario === "paginated-jobs";

    const expectedHold = reasonByCase[scenario];

    if (expectedHold === undefined) {
      expect(holds.size).toBe(0);
    } else {
      const [key, expected] = expectedHold;
      expect(holds.get(key)).toContain(expected);
    }

    const failed = scenario === "apply-failed";
    expect(checkpoints).toHaveLength(success || failed ? 2 : 0);
    expect(receipts.map((receipt) => receipt.sha)).toEqual(
      success || failed ? [eligible] : []
    );
    expect(recoveries).toBe(failed ? 1 : 0);
    expect(cycle.context.successful).toBe(success ? eligible : liveSha);

    if (failed) {
      expect(receipts[0]).toMatchObject({
        gate: "deploy",
        recovered: true,
        result: "failed",
      });
      expect(checkpoints[1]).toMatchObject({
        failed: eligible,
        preparedRetries: { [head]: Number.MAX_SAFE_INTEGER },
        successful: liveSha,
      });

      const next = yield* selectPrepared<
        ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
      >(
        evidence,
        cycle.context,
        (yield* Clock.currentTimeMillis) / 1000,
        (sha, reason) => {
          holds.set(sha, reason);
        }
      ).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          commands
        ),
        Effect.provideService(HttpClient.HttpClient, client(scenario))
      );

      expect(Option.isNone(next)).toBe(true);
      expect(holds.get(eligible)).toBe("DeployFailureBarrier");
    }
  });

for (const scenario of Case.literals) {
  it.effect(
    `prepared ship requires exact ancestry, fence and bytes: ${scenario}`,
    () => checkPrepared(scenario).pipe(Effect.provide(NodeServices.layer))
  );
}

it.effect("a newer fence attempt invalidates a cached success", () =>
  Effect.gen(function* checkRerun() {
    let attempt = 1;
    let charged = 0;
    const jobRequests: string[] = [];

    const evidence = preparedEvidence(
      repository,
      [
        "--candidate-file",
        "/fixture/list",
        "--artifact-helper",
        "/fixture/helper",
      ],
      "/fixture",
      {
        charge: githubBudget(),
        save: Effect.sync(() => {
          charged += 1;
        }),
      }
    );

    const http = HttpClient.make((request) => {
      const path = new URL(request.url).pathname;

      if (path.endsWith("/runs")) {
        if (request.headers["if-none-match"] === `"attempt-${attempt}"`) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 304 })
            )
          );
        }

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              {
                workflow_runs: [
                  { ...run(eligible, "ready"), run_attempt: attempt },
                ],
              },
              { headers: { ETag: `"attempt-${attempt}"` } }
            )
          )
        );
      }

      jobRequests.push(path);

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            jobs: [
              {
                conclusion: attempt === 1 ? "success" : "failure",
                head_sha: eligible,
                name: "fence",
                status: "completed",
              },
            ],
          })
        )
      );
    });

    const fence = evidence
      .fence(eligible)
      .pipe(Effect.provideService(HttpClient.HttpClient, http));

    expect(yield* fence).toBe(true);
    expect(yield* fence).toBe(true);
    attempt = 2;
    expect(yield* fence).toBe(false);
    expect(yield* fence).toBe(false);
    expect(charged).toBe(6);
    expect(jobRequests.map((path) => path.split("/").at(-2))).toEqual([
      "1",
      "2",
    ]);
  })
);

it.effect("first-parent proof refuses both a cycle and a 257th commit", () =>
  Effect.gen(function* boundedProof() {
    const commits = Array.from({ length: 257 }, (_, index) =>
      index.toString(16).padStart(40, "0")
    );

    const tip = commits[256] ?? head;

    for (const cycle of [true, false]) {
      const holds = new Map<string, string>();
      let count = 0;

      const outcome = yield* selectPrepared(
        {
          artifact: () =>
            Effect.die("unproven ancestry cannot check artifacts"),
          eligible: Effect.succeed(new Set([tip])),
          fence: () => Effect.die("unproven ancestry cannot check fences"),
          firstParent: (sha) =>
            Effect.sync(() => {
              count += 1;

              return cycle
                ? tip
                : (commits[commits.indexOf(sha) - 1] ?? checkpoint);
            }),
          head: Effect.succeed(tip),
        },
        { failed: "", successful: checkpoint },
        0,
        (sha, reason) => {
          holds.set(sha, reason);
        }
      );

      expect(Option.isNone(outcome)).toBe(true);
      expect(holds.size).toBe(1);
      expect(holds.get("")).toContain("BeyondFirstParentLimit");
      expect(count).toBe(cycle ? 1 : 256);
    }
  })
);

it.effect("GitHub request debt survives restarting the signer", () =>
  Effect.gen(function* restartBudget() {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = `${dir}/budget.json`;
    const beforeRestart = yield* durableGithubBudget(file);

    for (let request = 0; request < 39; request += 1) {
      expect(beforeRestart.charge(1000)).toBe(true);
    }

    yield* beforeRestart.save;

    const restarted = yield* durableGithubBudget(file);
    expect(restarted.charge(3_600_999)).toBe(false);
    expect(restarted.charge(3_601_000)).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer))
);

it.prop(
  "GitHub evidence charges fewer than 40 requests in any rolling hour",
  [
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ maximum: 180_000, minimum: 0 }))
    ).check(Schema.isMinLength(100), Schema.isMaxLength(250)),
  ],
  ([ticks]) => {
    const reserve = githubBudget();
    const charged: number[] = [];
    let previous = 0;

    for (const elapsed of ticks) {
      const now = previous + elapsed;
      previous = now;
      const count = charged.filter((time) => time > now - 3_600_000).length;
      const admitted = reserve(now);
      expect(admitted).toBe(count < 39);

      if (admitted) {
        charged.push(now);
      }
    }

    const burst = githubBudget();
    expect(
      Array.from({ length: 100 }, () => burst(0)).filter(Boolean)
    ).toHaveLength(39);
  }
);
