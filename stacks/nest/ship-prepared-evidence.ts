import { Effect, Schema } from "effect";
import { HttpClient } from "effect/http";

import {
  AbsolutePath,
  readBoundedRegularFile,
} from "../../packages/alchemy-nest/src/files.ts";
import {
  decodePrepared,
  maxPreparedBytes,
  Sha256,
} from "./prepared-payload.ts";
import { Sha } from "./ship-config.ts";
import { boundedOutput, decodeUtf8, readCommand } from "./ship-process.ts";
import { maxFirstParents } from "./ship-select.ts";
import { FleetError } from "./stage-config.ts";

const maxList = 2 * 1024 * 1024;

export const PreparedArguments = Schema.Tuple([
  Schema.Literal("--candidate-file"),
  AbsolutePath,
  Schema.Literal("--artifact-helper"),
  AbsolutePath,
]);

export type PreparedArgs = typeof PreparedArguments.Type;

const unavailable = () =>
  new FleetError({ reason: "Prepared ship evidence unavailable or malformed" });

const lines = (text: string) =>
  Effect.gen(function* decodeLines() {
    if (text === "") {
      return new Set<string>();
    }

    const entries = text.slice(0, -1).split("\n");
    const shas = new Set(entries);

    if (
      !text.endsWith("\n") ||
      shas.size !== entries.length ||
      !entries.every(Schema.is(Sha))
    ) {
      return yield* unavailable();
    }

    return shas;
  });

const readLine = (schema: typeof AbsolutePath, text: string) =>
  text.endsWith("\n")
    ? Schema.decodeEffect(schema)(text.slice(0, -1)).pipe(
        Effect.mapError(unavailable)
      )
    : Effect.fail(unavailable());

const Ref = Schema.fromJsonString(
  Schema.Struct({
    object: Schema.Struct({ sha: Sha, type: Schema.Literal("commit") }),
    ref: Schema.Literal("refs/heads/main"),
  })
);

const Commit = Schema.fromJsonString(
  Schema.Struct({
    parents: Schema.Array(Schema.Struct({ sha: Sha })),
    sha: Sha,
  })
);

const Fence = Schema.fromJsonString(
  Schema.Struct({
    workflow_runs: Schema.Array(
      Schema.Struct({
        conclusion: Schema.NullOr(Schema.String),
        event: Schema.String,
        head_branch: Schema.String,
        head_sha: Sha,
        id: Schema.Int.check(Schema.isGreaterThan(0)),
        path: Schema.String,
        run_attempt: Schema.Int.check(Schema.isGreaterThan(0)),
        status: Schema.String,
      })
    ),
  })
);

const FenceJobs = Schema.fromJsonString(
  Schema.Struct({
    jobs: Schema.Array(
      Schema.Struct({
        conclusion: Schema.NullOr(Schema.String),
        head_sha: Sha,
        name: Schema.String,
        status: Schema.String,
      })
    ),
  })
);

const github = Effect.fn("Ship.githubEvidence")(
  function* github(repository: string, route: string) {
    const client = yield* HttpClient.HttpClient;

    const response = yield* client.get(
      `https://api.github.com/repos/${repository}/${route}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "rat-king",
        },
      }
    );

    if (response.status !== 200) {
      return yield* unavailable();
    }

    return yield* boundedOutput(response.stream, 262_144);
  },
  (effect) =>
    effect.pipe(Effect.timeout("15 seconds"), Effect.mapError(unavailable))
);

export const preparedEvidence = (
  repository: string,
  args: PreparedArgs,
  workspace: string
) => {
  const [, list, , helper] = args;

  const run = (helperArgs: readonly string[], maximum: number) =>
    readCommand(helper, helperArgs, workspace, maximum, {});

  const parents = new Map<string, string | undefined>();

  return {
    artifact: Effect.fn("Ship.snapshot")(function* artifact(sha: string) {
      const pin = yield* readLine(Sha256, yield* run(["--pin", sha], 65));
      const snapshot = yield* readLine(AbsolutePath, yield* run([sha], 4096));

      if (snapshot !== `${workspace}/${sha}.bundle`) {
        return yield* unavailable();
      }

      const bytes = yield* readBoundedRegularFile(
        snapshot,
        maxPreparedBytes
      ).pipe(Effect.mapError(unavailable));

      return yield* decodePrepared(bytes, { commit: sha, sha256: pin });
    }),
    eligible: Effect.gen(function* eligible() {
      const candidateBytes = yield* readBoundedRegularFile(list, maxList).pipe(
        Effect.mapError(unavailable)
      );

      const candidates = yield* lines(yield* decodeUtf8(candidateBytes));
      const pinned = yield* lines(yield* run(["--eligible"], maxList));

      return new Set([...pinned].filter((sha) => candidates.has(sha)));
    }),
    fence: Effect.fn("Ship.preparedFence")(function* fence(sha: string) {
      const text = yield* github(
        repository,
        `actions/workflows/fence.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=1`
      );

      const {
        workflow_runs: [workflow],
      } = yield* Schema.decodeEffect(Fence)(text).pipe(
        Effect.mapError(unavailable)
      );

      if (
        workflow === undefined ||
        workflow.head_sha !== sha ||
        workflow.head_branch !== "main" ||
        workflow.event !== "push" ||
        workflow.path !== ".github/workflows/fence.yml" ||
        workflow.status !== "completed" ||
        workflow.conclusion !== "success"
      ) {
        return false;
      }

      const jobs = yield* github(
        repository,
        `actions/runs/${workflow.id}/attempts/${workflow.run_attempt}/jobs?per_page=100`
      );

      const decoded = yield* Schema.decodeEffect(FenceJobs)(jobs).pipe(
        Effect.mapError(unavailable)
      );

      const fences = decoded.jobs.filter((job) => job.name === "fence");

      return (
        fences.length === 1 &&
        fences.every(
          (job) =>
            job.head_sha === sha &&
            job.status === "completed" &&
            job.conclusion === "success"
        )
      );
    }),
    firstParent: Effect.fn("Ship.pushedFirstParent")(function* firstParent(
      sha: string
    ) {
      if (parents.has(sha)) {
        return parents.get(sha);
      }

      const text = yield* github(repository, `git/commits/${sha}`);

      const commit = yield* Schema.decodeEffect(Commit)(text).pipe(
        Effect.mapError(unavailable)
      );

      if (commit.sha !== sha) {
        return yield* unavailable();
      }

      if (parents.size >= maxFirstParents * 2) {
        parents.delete(parents.keys().next().value ?? "");
      }

      const first = commit.parents[0]?.sha;
      parents.set(sha, first);

      return first;
    }),
    head: Effect.gen(function* pushedMain() {
      const text = yield* github(repository, "git/ref/heads/main");

      return (yield* Schema.decodeEffect(Ref)(text).pipe(
        Effect.mapError(unavailable)
      )).object.sha;
    }),
  };
};
