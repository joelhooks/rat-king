import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import { HttpClient } from "effect/http";

import {
  AbsolutePath,
  readBoundedRegularFile,
} from "../../packages/alchemy-nest/src/files.ts";
import { allowManifest } from "./prepared-manifest.ts";
import {
  decodePrepared,
  maxPreparedBytes,
  Sha256,
} from "./prepared-payload.ts";
import { Sha } from "./ship-config.ts";
import type { GithubBudget } from "./ship-github-budget.ts";
import { githubBudget } from "./ship-github-budget.ts";
import { parentCache } from "./ship-parent-cache.ts";
import type { ParentCache } from "./ship-parent-cache.ts";
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
        run_started_at: Schema.optionalKey(Schema.String),
        status: Schema.String,
        updated_at: Schema.optionalKey(Schema.String),
      })
    ),
  })
);

export const fenceJobName = "fence";

const pendingFenceMillis = 30 * 60 * 1000;

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

const rateLimited = () => new FleetError({ reason: "GitHubRateLimited" });

const evidenceError = (error: { readonly _tag: string }) =>
  Schema.is(FleetError)(error) ? error : unavailable();

const github = Effect.fn("Ship.githubEvidence")(
  function* github(
    repository: string,
    route: string,
    budget: GithubBudget,
    etag?: string
  ) {
    const now = yield* Clock.currentTimeMillis;

    if (!budget.charge(now)) {
      return yield* rateLimited();
    }

    yield* budget.save;
    const client = yield* HttpClient.HttpClient;

    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "rat-king",
    };

    const response = yield* client.get(
      `https://api.github.com/repos/${repository}/${route}`,
      {
        headers:
          etag === undefined ? headers : { ...headers, "If-None-Match": etag },
      }
    );

    const remaining =
      response.status === 429
        ? 0
        : Number(response.headers["x-ratelimit-remaining"]);

    const reset = Number(response.headers["x-ratelimit-reset"]) * 1000;

    if (budget.observe?.(now, remaining, reset) === true) {
      yield* budget.save;
    }

    if (response.status === 304 && etag !== undefined) {
      return { response, text: undefined };
    }

    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers["x-ratelimit-remaining"] === "0")
    ) {
      return yield* rateLimited();
    }

    if (response.status !== 200) {
      return yield* unavailable();
    }

    return { response, text: yield* boundedOutput(response.stream, 262_144) };
  },
  (effect) =>
    effect.pipe(Effect.timeout("15 seconds"), Effect.mapError(evidenceError))
);

const fenceJobs = Effect.fn("Ship.fenceJobs")(function* fenceJobs(
  get: (route: string) => ReturnType<typeof github>,
  route: string
) {
  const all: (typeof FenceJobs.Type)["jobs"][number][] = [];

  for (let page = 1; page <= 5; page += 1) {
    const { response, text } = yield* get(
      page === 1 ? route : `${route}&page=${page}`
    );

    const { jobs } = yield* Schema.decodeUnknownEffect(FenceJobs)(text).pipe(
      Effect.mapError(unavailable)
    );

    all.push(...jobs);

    if (response.headers.link?.includes('rel="next"') !== true) {
      return all;
    }
  }

  return yield* unavailable();
});

const rejectWorkspace = () =>
  new FleetError({
    reason:
      "Prepared releases must be an owned workspace without symbolic or writable ancestors",
  });

export const verifyShipWorkspace = Effect.fn("Ship.verifyWorkspace")(
  function* verifyShipWorkspace(directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const uid = process.getuid?.();

    if (
      !path.isAbsolute(directory) ||
      (yield* fs.realPath(directory)) !== directory ||
      uid === undefined
    ) {
      return yield* rejectWorkspace();
    }

    let current = directory;

    for (;;) {
      const stat = yield* fs.lstat(current);
      const owner = Option.getOrUndefined(stat.uid);
      const groupWritable = Math.floor(stat.mode / 16) % 2 === 1;
      const otherWritable = Math.floor(stat.mode / 2) % 2 === 1;

      if (
        stat.type !== "Directory" ||
        (owner !== uid && (current === directory || owner !== 0)) ||
        groupWritable ||
        otherWritable
      ) {
        return yield* rejectWorkspace();
      }

      const parent = path.dirname(current);

      if (parent === current) {
        return yield* Effect.void;
      }

      current = parent;
    }
  }
);

const exactFence = Effect.fn("Ship.exactFence")(function* exactFence(
  workflow: (typeof Fence.Type)["workflow_runs"][number] | undefined,
  sha: string
) {
  if (workflow === undefined) {
    return yield* new FleetError({
      reason: "NotPushTip: no exact pushed-main fence run",
    });
  }

  if (
    workflow.head_sha !== sha ||
    workflow.head_branch !== "main" ||
    workflow.event !== "push" ||
    workflow.path !== ".github/workflows/fence.yml"
  ) {
    return yield* unavailable();
  }

  if (workflow.status !== "completed") {
    const now = yield* Clock.currentTimeMillis;

    const updated = Date.parse(
      workflow.run_started_at ?? workflow.updated_at ?? ""
    );

    return yield* new FleetError({
      reason:
        Number.isFinite(updated) && now - updated >= pendingFenceMillis
          ? "ExactFencePendingOverdue"
          : "ExactFencePending",
    });
  }

  return workflow;
});

const artifactMissing = () =>
  new FleetError({ reason: "ArtifactMissingOrUnreadable" });

const ephemeralParents = (): ParentCache => ({
  parents: parentCache(),
  save: Effect.void,
});

const ephemeralBudget = (): GithubBudget => ({
  charge: githubBudget(),
  save: Effect.void,
});

export const preparedEvidence = (
  repository: string,
  args: PreparedArgs,
  workspace: string,
  budget: GithubBudget = ephemeralBudget(),
  cache: ParentCache = ephemeralParents()
) => {
  const [, list, , helper] = args;

  const run = (helperArgs: readonly string[], maximum: number) =>
    readCommand(helper, helperArgs, workspace, maximum, {}).pipe(
      Effect.mapError(
        () =>
          new FleetError({
            reason: `ArtifactHelperFailed: ${helperArgs[0]?.startsWith("--") === true ? helperArgs[0] : "snapshot"}`,
          })
      )
    );

  const { parents } = cache;
  const completed = new Map<string, boolean>();

  const runs = new Map<
    string,
    { readonly etag: string | undefined; readonly text: string }
  >();

  let ref:
    | { readonly sha: string; readonly etag: string | undefined }
    | undefined;

  const get = (route: string, etag?: string) =>
    github(repository, route, budget, etag);

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
      ).pipe(Effect.mapError(artifactMissing));

      const payload = yield* decodePrepared(bytes, {
        commit: sha,
        sha256: pin,
      });

      yield* allowManifest(payload.manifest);

      return payload;
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
      const cached = runs.get(sha);

      const { response, text } = yield* get(
        `actions/workflows/fence.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=1`,
        cached?.etag
      );

      const body = text ?? cached?.text;

      if (text !== undefined) {
        if (runs.size >= maxFirstParents * 2) {
          runs.delete(runs.keys().next().value ?? "");
        }

        runs.set(sha, { etag: response.headers.etag, text });
      }

      const {
        workflow_runs: [candidate],
      } = yield* Schema.decodeUnknownEffect(Fence)(body).pipe(
        Effect.mapError(unavailable)
      );

      const workflow = yield* exactFence(candidate, sha);

      if (workflow.conclusion !== "success") {
        return false;
      }

      const key = `${sha}:${workflow.id}:${workflow.run_attempt}`;
      const verdict = completed.get(key);

      if (verdict !== undefined) {
        return verdict;
      }

      const jobs = yield* fenceJobs(
        get,
        `actions/runs/${workflow.id}/attempts/${workflow.run_attempt}/jobs?per_page=100`
      );

      const fences = jobs.filter((job) => job.name === fenceJobName);

      const ok =
        fences.length === 1 &&
        fences.every(
          (job) =>
            job.head_sha === sha &&
            job.status === "completed" &&
            job.conclusion === "success"
        );

      if (completed.size >= maxFirstParents * 2) {
        completed.delete(completed.keys().next().value ?? "");
      }

      completed.set(key, ok);

      return ok;
    }),
    firstParent: Effect.fn("Ship.pushedFirstParent")(function* firstParent(
      sha: string
    ) {
      if (parents.has(sha)) {
        return parents.get(sha);
      }

      const { text } = yield* get(`git/commits/${sha}`);

      const commit = yield* Schema.decodeUnknownEffect(Commit)(text).pipe(
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
      yield* cache.save;

      return first;
    }),
    head: Effect.gen(function* pushedMain() {
      const { response, text } = yield* get("git/ref/heads/main", ref?.etag);

      if (text === undefined && ref !== undefined) {
        return ref.sha;
      }

      const { object } = yield* Schema.decodeUnknownEffect(Ref)(text).pipe(
        Effect.mapError(unavailable)
      );

      ref = { etag: response.headers.etag, sha: object.sha };

      return ref.sha;
    }),
  };
};
