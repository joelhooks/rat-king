import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";

import { runtimeDrift } from "../../../stacks/nest/runner-drift.ts";
import { withShipLock } from "../../../stacks/nest/ship-lock.ts";
import { fenceJobName } from "../../../stacks/nest/ship-prepared-evidence.ts";
import { readCommand } from "../../../stacks/nest/ship-process.ts";

const rootUrl = new URL("../../../", import.meta.url);

it.effect("the real fence workflow exposes the expected job name", () =>
  Effect.gen(function* checkWorkflow() {
    const fs = yield* FileSystem.FileSystem;

    const path = yield* Path.Path;

    const workflow = yield* path.fromFileUrl(
      new URL(".github/workflows/fence.yml", rootUrl)
    );

    const yaml = yield* fs.readFileString(workflow);

    const jobs =
      /^jobs:\n(?<jobs>(?:[ \t].*\n|\n)+)/mu.exec(yaml)?.groups?.jobs ?? "";

    const section = new RegExp(
      `^  ${fenceJobName}:\\n(?<body>(?: {4}.*\\n|\\n)+)`,
      "mu"
    ).exec(jobs)?.groups?.body;

    expect(section).toBeDefined();
    expect(section).not.toMatch(/^ {4}name:/mu);
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "installed signer entry imports without loading builder modules",
  () => {
    const source = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/^(?:esbuild)$|(?:deployment-build|operator-build|fleet-build|ship-build)\\.ts$/.test(specifier)) {
        throw new Error('unexpected builder import: ' + specifier);
      }
      return next(specifier, context);
    } });
    await import(${JSON.stringify(new URL("stacks/nest/prepared-apply.ts", rootUrl).href)});
    process.stdout.write('trusted-only');`;

    return readCommand(
      process.execPath,
      ["--input-type=module", "--eval", source],
      import.meta.dirname,
      128,
      {}
    ).pipe(
      Effect.tap((output) =>
        Effect.sync(() => {
          expect(output).toBe("trusted-only");
        })
      ),
      Effect.provide(NodeServices.layer)
    );
  }
);

it.effect("atomic entry replacement with identical bytes is signer drift", () =>
  Effect.gen(function* detectDrift() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const entry = `${root}/cli.ts`;
    yield* fs.writeFileString(entry, "same source");

    const { drifted } = yield* runtimeDrift.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ RAT_KING_SHIP_RUNTIME_ENTRY: entry })
        )
      )
    );

    expect(yield* drifted).toBe(false);
    yield* fs.writeFileString(`${root}/next.ts`, "same source");
    yield* fs.rename(`${root}/next.ts`, entry);
    expect(yield* drifted).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("legacy and prepared ship use the same owned process lock", () =>
  Effect.gen(function* verifyContention() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const entry = `${root}/fixture.mjs`;
    const lock = `${root}/ship.lock`;
    const fixture = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(`${root}/observed`)}, process.cwd() + ' ' + process.argv[2]);`;
    yield* fs.writeFileString(entry, fixture);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const mac = process.platform === "darwin";
    const command = mac ? "/usr/bin/lockf" : "/usr/bin/flock";
    const flags = mac ? ["-k", "-t", "0"] : ["--nonblock", "--no-fork", "--"];

    const blocker = yield* spawner.spawn(
      ChildProcess.make(command, [
        ...flags,
        lock,
        process.execPath,
        "-e",
        'process.stdout.write("ready\\n"); process.stdin.resume();',
      ])
    );

    const ready = yield* blocker.stdout.pipe(
      Stream.decodeText(),
      Stream.runHead
    );

    expect(ready).toEqual(Option.some("ready\n"));

    for (const mode of ["ship", "ship-prepared"]) {
      const contended = yield* withShipLock(
        root,
        entry,
        `${root}/stage`,
        [mode],
        root
      ).pipe(Effect.result);

      expect(Result.isFailure(contended)).toBe(true);
    }

    expect(yield* fs.exists(`${root}/observed`)).toBe(false);
    yield* Stream.run(Stream.empty, blocker.stdin);
    yield* blocker.exitCode;
    yield* withShipLock(root, entry, `${root}/stage`, ["ship"], root);
    expect(yield* fs.readFileString(`${root}/observed`)).toBe(`${root} ship`);
  }).pipe(Effect.provide(NodeServices.layer))
);
