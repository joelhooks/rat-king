import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";

import { digest } from "../../../packages/alchemy-nest/src/files.ts";
import {
  decodePrepared,
  Sha256,
} from "../../../stacks/nest/prepared-payload.ts";
import { hasOnlyBuildEnvironment } from "../../../stacks/nest/ship-build.ts";
import {
  boundedOutput,
  readCommand,
} from "../../../stacks/nest/ship-process.ts";

const sha = "a".repeat(40);

const populateRoot = Effect.fn("Fixture.copyBuildInputs")(
  function* populateRoot(origin: string, root: string) {
    const fs = yield* FileSystem.FileSystem;

    for (const directory of ["apps/mailbox", "stacks"]) {
      yield* fs.makeDirectory(`${root}/${directory}`, { recursive: true });
    }

    for (const directory of [
      "apps/mailbox/src",
      "apps/mailbox/cli",
      "stacks/nest",
    ]) {
      yield* fs.copy(`${origin}/${directory}`, `${root}/${directory}`);
    }

    for (const file of [
      "package.json",
      "tsconfig.base.json",
      "apps/mailbox/tsconfig.json",
    ]) {
      yield* fs.copyFile(`${origin}/${file}`, `${root}/${file}`);
    }

    for (const dependency of [
      "apps/billing-ingress",
      "apps/mailbox/node_modules",
      "apps/ratking-cli",
      "node_modules",
      "packages",
    ]) {
      yield* fs.symlink(`${origin}/${dependency}`, `${root}/${dependency}`);
    }
  }
);

const nodeFixture = Effect.fn("Fixture.node")(function* nodeFixture(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, args, {
      cwd,
      env,
      extendEnv: false,
      stdin: "ignore",
    })
  );

  const [code, stdout, stderr] = yield* Effect.all(
    [
      child.exitCode,
      boundedOutput(child.stdout, 32_768),
      boundedOutput(child.stderr, 32_768),
    ],
    { concurrency: "unbounded" }
  );

  return { code: Number(code), stderr, stdout };
});

it.live(
  "the four actual fleet entrypoints produce identical containers in different roots and HOMEs",
  () =>
    Effect.gen(function* reproducible() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const origin = path.resolve(import.meta.dirname, "../../..");
      const fixture = `${import.meta.dirname}/fixtures/prepared-build.ts`;
      const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

      const hashes = yield* Effect.forEach(["one", "two with space"], (name) =>
        Effect.gen(function* build() {
          const root = `${parent}/${name}/source`;
          const home = `${parent}/${name}/home`;
          yield* populateRoot(origin, root);
          yield* fs.makeDirectory(home);

          const { code, stdout, stderr } = yield* nodeFixture(
            [fixture, root, sha, origin],
            root,
            { HOME: home, PATH: "/usr/bin:/bin" }
          );

          expect(code, `${stdout}\n${stderr}`).toBe(0);

          return yield* Schema.decodeEffect(Sha256)(stdout.trim());
        })
      );

      expect(hashes[0]).toBe(hashes[1]);
    }).pipe(Effect.provide(NodeServices.layer))
);

const loadOnly = `
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { pathToFileURL } from "node:url";
const deny = () => { throw new Error("payload tried network I/O at import"); };
globalThis.fetch = deny;
Socket.prototype.connect = deny;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "cloudflare:workers"
      ? { shortCircuit: true, url: "data:text/javascript,export class DurableObject {}" }
      : next(specifier, context);
  }
});
const [workerPath, cliPath, backupPath, restartPath] = process.argv.slice(1);
const read = (path) => import(pathToFileURL(path).href);
const [worker, cli, backup, restart] = await Promise.all([workerPath, cliPath, backupPath, restartPath].map(read));
if (typeof worker.Mailbox !== "function" || typeof cli.runMailbox !== "function" || !backup.program || !restart.program) {
  throw new Error("fleet exports missing");
}
process.stdout.write("loaded four fleet payloads");
`;

it.live(
  "real ship-build output imports all four payloads without network I/O",
  () =>
    Effect.gen(function* smoke() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const origin = path.resolve(import.meta.dirname, "../../..");
      const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${parent}/source`;
      const home = `${parent}/home`;
      const runtime = `${parent}/runtime`;
      yield* populateRoot(origin, root);
      yield* fs.makeDirectory(home);
      yield* fs.makeDirectory(runtime);
      yield* fs.writeFileString(`${root}/.gitignore`, "node_modules\n");

      const env = {
        HOME: home,
        PATH: "/usr/bin:/bin",
        XDG_RUNTIME_DIR: runtime,
      };

      const git = (args: readonly string[]) =>
        readCommand("git", args, root, 8192, {
          ...env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        });

      yield* git(["init", "-q"]);
      yield* git([
        "add",
        "--",
        ".gitignore",
        "apps",
        "package.json",
        "packages",
        "stacks",
        "tsconfig.base.json",
      ]);
      yield* git([
        "-c",
        "user.email=fixture",
        "-c",
        "user.name=Fixture",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fleet fixture",
      ]);
      const commit = (yield* git(["rev-parse", "HEAD"])).trim();
      const output = `${parent}/fleet.bundle`;

      const built = yield* nodeFixture(
        [
          `${root}/stacks/nest/cli.ts`,
          "ship-build",
          "--sha",
          commit,
          "--output",
          output,
        ],
        root,
        env
      );

      expect(built.code, `${built.stdout}\n${built.stderr}`).toBe(0);

      const bytes = yield* fs.readFile(output);

      const payload = yield* decodePrepared(bytes, {
        commit,
        sha256: digest(bytes),
      });

      const files: string[] = [];

      for (const key of ["worker", "cli", "backup", "restart"] as const) {
        const file = `${parent}/${key}.mjs`;
        yield* fs.writeFileString(file, payload[key]);
        files.push(file);
      }

      const loaded = yield* nodeFixture(
        ["--input-type=module", "--eval", loadOnly, ...files],
        parent,
        env
      );

      expect(loaded.code, loaded.stderr).toBe(0);
      expect(loaded.stdout).toBe("loaded four fleet payloads");

      for (const name of ["backup", "restart"]) {
        const invoked = yield* nodeFixture(
          [`${parent}/${name}.mjs`],
          parent,
          env
        );

        expect(invoked.code).not.toBe(0);
        expect(`${invoked.stdout}\n${invoked.stderr}`).toContain("SchemaError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 }
);

it("only Darwin accepts the exact Core Foundation environment key", () => {
  const env = {
    HOME: "/fixture/home",
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: "/fixture/runtime",
    __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
  };

  expect(hasOnlyBuildEnvironment(env, "darwin")).toBe(true);
  expect(hasOnlyBuildEnvironment(env, "linux")).toBe(false);
  expect(
    hasOnlyBuildEnvironment(
      { ...env, __CF_USER_TEXT_ENCODING_EXTRA: "1" },
      "darwin"
    )
  ).toBe(false);
});

const Forbidden = Schema.Literals([
  "CREDENTIALS_DIRECTORY",
  "SSH_AUTH_SOCK",
  "RAT_KING_STAGE_CONFIG",
  "AGENT_SECRETS_SOCKET",
]);

it.live.prop(
  "ship-build refuses credential, stage and socket inputs before inspecting the source",
  [Forbidden],
  ([name]) =>
    Effect.gen(function* refusesInput() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const cli = path.resolve(
        import.meta.dirname,
        "../../../stacks/nest/cli.ts"
      );

      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const output = `${root}/payload.bundle`;
      const home = `${root}/home`;
      const sockets = `${root}/runtime`;
      yield* fs.makeDirectory(home);
      yield* fs.makeDirectory(sockets);
      const fakeInput = "/fixture/forbidden";

      const { code, stdout, stderr } = yield* nodeFixture(
        [cli, "ship-build", "--sha", sha, "--output", output],
        root,
        {
          [name]: fakeInput,
          HOME: home,
          PATH: "/usr/bin:/bin",
          XDG_RUNTIME_DIR: sockets,
        }
      );

      const diagnostic = `${stdout}\n${stderr}`;
      expect(code).not.toBe(0);
      expect(diagnostic).toContain("without credential or socket inputs");
      expect(diagnostic).not.toContain(fakeInput);
      expect(yield* fs.exists(output)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 }, timeout: 30_000 }
);
