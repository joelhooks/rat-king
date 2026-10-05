import {
  Config,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { blobHash, isExempt } from "./exemptions.ts";
import { Instance, privateArtifact, violations } from "./rules.ts";

export class FenceError extends Schema.TaggedError<FenceError>()("FenceError", {
  reason: Schema.String,
}) {}

export const execute = Effect.fn("fence.execute")(function* execute({
  executable,
  args,
  cwd,
}: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const handle = yield* spawner.spawn(
    ChildProcess.make(executable, args, { cwd })
  );

  const result = yield* Effect.all(
    {
      code: handle.exitCode,
      output: Stream.runCollect(handle.stdout),
      stderr: Stream.runCollect(handle.stderr),
    },
    { concurrency: "unbounded" }
  );

  return {
    bytes: Buffer.concat(result.output),
    code: result.code,
    stderrBytes: Buffer.concat(result.stderr),
  };
}, Effect.scoped);

const git = Effect.fn("fence.git")(function* git({
  args,
  root,
}: {
  readonly args: readonly string[];
  readonly root: string;
}) {
  const result = yield* execute({ args, cwd: root, executable: "git" });

  if (result.code !== 0) {
    return yield* new FenceError({
      reason: "Git read failed; values redacted.",
    });
  }

  return result.bytes;
});

export const loadInstance = Effect.fn("fence.loadInstance")(
  function* loadInstance({ generic }: { readonly generic: boolean }) {
    if (generic) {
      return null;
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const location = yield* Config.String("RATS_NEST_INSTANCE").pipe(
      Config.orElse(() =>
        Config.String("HOME").pipe(
          Config.map((home) =>
            path.join(home, ".config", "rats-nest", "instance.json")
          )
        )
      )
    );

    const stat = yield* fs.stat(location);

    if (stat.mode % 0o1000 !== 0o600) {
      return yield* new FenceError({
        reason: "Private instance must have mode 600.",
      });
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(Instance), {
      onExcessProperty: "error",
    })(yield* fs.readFileString(location));
  }
);

const nulPaths = (bytes: Uint8Array) =>
  new TextDecoder()
    .decode(bytes)
    .split("\0")
    .filter((value) => value !== "");

const LeakFinding = Schema.Struct({
  File: Schema.String,
  RuleID: Schema.String,
});

const unapprovedLeakRules = (
  detected: readonly (typeof LeakFinding.Type)[],
  approved: (finding: typeof LeakFinding.Type) => boolean
) =>
  detected.flatMap((finding) =>
    approved(finding) ? [] : [`gitleaks:${finding.RuleID}`]
  );

export const scan = Effect.fn("fence.scan")(function* scan({
  root,
  mode,
  generic,
}: {
  readonly root: string;
  readonly mode: "staged" | "tree" | "history";
  readonly generic: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inventory = yield* loadInstance({ generic });
  const scratch = path.join(root, ".fence-tmp");
  yield* fs.makeDirectory(scratch, { recursive: true });
  const directory = yield* fs.makeTempDirectoryScoped({ directory: scratch });
  const findings = new Set<string>();

  const blobs = new Map<
    string,
    { readonly name: string; readonly sha256: string }
  >();

  let count = 0;

  const inspect = Effect.fn("fence.inspect")(function* inspect({
    name,
    bytes,
  }: {
    readonly name: string;
    readonly bytes: Uint8Array;
  }) {
    count += 1;

    const sha256 = blobHash(bytes);

    for (const rule of violations({ content: name, inventory })) {
      findings.add(rule);
    }

    for (const rule of violations({
      content: new TextDecoder().decode(bytes),
      inventory,
      name,
      sha256,
    })) {
      findings.add(rule);
    }

    if (privateArtifact(name)) {
      findings.add("private-artifact");
    }

    const file = path.join(directory, String(count));
    blobs.set(path.resolve(file), { name, sha256 });
    yield* fs.writeFile(file, bytes);
  });

  if (mode === "history") {
    const commits = new TextDecoder()
      .decode(yield* git({ args: ["rev-list", "--all", "HEAD"], root }))
      .trim()
      .split("\n");

    const seen = new Set<string>();

    for (const commit of commits) {
      const records = nulPaths(
        yield* git({ args: ["ls-tree", "-r", "-z", commit], root })
      );

      for (const record of records) {
        const tab = record.indexOf("\t");
        const name = record.slice(tab + 1);
        const [, kind, oid] = record.slice(0, tab).split(" ");

        if (tab === -1 || kind !== "blob" || oid === undefined) {
          return yield* new FenceError({
            reason: "Invalid Git tree or submodule; refusing publication.",
          });
        }

        const key = `${oid}:${name}`;

        if (!seen.has(key)) {
          seen.add(key);
          yield* inspect({
            bytes: yield* git({ args: ["cat-file", "blob", oid], root }),
            name,
          });
        }
      }
    }
  } else {
    const args =
      mode === "staged"
        ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
        : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];

    const names = new Set(nulPaths(yield* git({ args, root })));

    for (const name of names) {
      if (mode === "staged") {
        yield* inspect({
          bytes: yield* git({ args: ["show", `:${name}`], root }),
          name,
        });
      } else {
        const file = path.join(root, name);
        const link = yield* fs.readLink(file).pipe(Effect.option);

        if (Option.isSome(link)) {
          yield* inspect({ bytes: new TextEncoder().encode(link.value), name });
        } else if (yield* fs.exists(file)) {
          const stat = yield* fs.stat(file);

          if (stat.type === "File") {
            yield* inspect({ bytes: yield* fs.readFile(file), name });
          }
        }
      }
    }
  }

  const report = path.join(directory, "gitleaks-report.json");

  const leaks = yield* execute({
    args: [
      "dir",
      directory,
      "--config",
      path.join(root, "tools", "fence", "gitleaks.toml"),
      "--redact",
      "--no-banner",
      "--report-format",
      "json",
      "--report-path",
      report,
    ],
    cwd: root,
    executable: "gitleaks",
  });

  if (leaks.code === 1) {
    const detected = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(LeakFinding))
    )(yield* fs.readFileString(report));

    if (detected.length === 0) {
      findings.add("gitleaks");
    }

    const unapproved = unapprovedLeakRules(detected, (finding) => {
      const blob =
        blobs.get(path.resolve(root, finding.File)) ??
        blobs.get(path.resolve(directory, finding.File));

      return (
        blob !== undefined &&
        isExempt(blob.name, blob.sha256, `gitleaks:${finding.RuleID}`)
      );
    });

    for (const rule of unapproved) {
      findings.add(rule);
    }
  } else if (leaks.code !== 0) {
    return yield* new FenceError({
      reason: "Gitleaks failed; refusing publication. Values redacted.",
    });
  }

  if (findings.size > 0) {
    return yield* new FenceError({
      reason: `Fence rejected content: ${[...findings].toSorted().join(", ")}. Values and paths redacted.`,
    });
  }

  return { count, generic };
}, Effect.scoped);
