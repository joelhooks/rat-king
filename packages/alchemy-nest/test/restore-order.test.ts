import { NodeServices } from "@effect/platform-node";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Vitest";
import { Context, Effect, Layer, Ref } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { restoreOwnedData } from "../../../stacks/nest/restore.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { HostShell } from "../src/host-shell.ts";
import { NodeProvider, NodeResource } from "../src/node-provider.ts";
import { HostDirectory, HostDirectoryProvider } from "../src/providers.ts";
import { s3Script } from "../src/s3-script.ts";
import { nodeUnit } from "../src/service-units.ts";
import { startupLayer } from "../src/startup-contract.ts";
import { UnitStartup } from "../src/unit-startup.ts";
import { checkedStack } from "./checked-stack.ts";

const home = "/home/example";

const dataRoot = "/srv/example/mailbox";

const archive = `${dataRoot}/.mailbox-restore-objects.tar`;

class Trace extends Context.Service<Trace, Ref.Ref<readonly string[]>>()(
  "Test/RestoreTrace"
) {}

const runtime = Layer.effectContext(
  Effect.gen(function* restoreRuntime() {
    const fake = yield* makeFakeShell();
    const trace = yield* Ref.make<readonly string[]>([]);

    const record = (event: string) =>
      Ref.update(trace, (events) => [...events, event]);

    const shell = {
      ...fake.shell,
      exec: Effect.fn("RestoreTest.exec")(function* exec(
        argv: readonly string[]
      ) {
        if (argv[0] === "python3" && argv[2] === backupScript) {
          expect(argv[3]).toBe("restore");
          expect(yield* fake.shell.stat(`${dataRoot}/celld`)).toMatchObject({
            kind: "directory",
            mode: 0o700,
          });
          yield* record("extract");
          yield* fake.shell.write({
            bytes: new TextEncoder().encode("restored payload"),
            mode: 0o600,
            path: `${dataRoot}/celld/state`,
          });
          yield* fake.shell.write({
            bytes: new Uint8Array(),
            mode: 0o600,
            path: archive,
          });

          return { code: 0, stdout: "BACKUP_RESTORED" };
        }

        if (argv[0] === "python3" && argv[2] === s3Script) {
          if (argv[6] === "import") {
            yield* record("import");

            return { code: 0, stdout: "LOGICAL_OBJECT_IMPORT_PASSED" };
          }

          return { code: 0, stdout: '{"status":200,"version":""}' };
        }

        if (argv.includes("--value")) {
          return { code: 0, stdout: "inactive" };
        }

        if (argv[0] === "systemctl" && argv[2] === "start") {
          yield* record("start");
        }

        return yield* fake.shell.exec(argv);
      }),
      purgeRoots: [...fake.shell.purgeRoots, dataRoot],
    };

    yield* shell.write({
      bytes: new TextEncoder().encode(
        'CELLD_BUCKET="s3://example"\nS3_ENDPOINT="http://127.0.0.1:18333"\n'
      ),
      mode: 0o600,
      path: `${home}/.config/rat-king/celld.env`,
    });
    yield* shell.write({
      bytes: new TextEncoder().encode(
        JSON.stringify({
          identities: [
            {
              credentials: [
                { accessKey: "example-access", secretKey: "example-value" },
              ],
            },
          ],
        })
      ),
      mode: 0o600,
      path: `${home}/.config/rat-king/s3.json`,
    });

    const startup = yield* UnitStartup.pipe(
      Effect.provide(
        startupLayer(
          "203.0.113.10",
          "scope",
          archive,
          restoreOwnedData(shell, dataRoot, {
            backupRoot: "/mnt/example/mailbox",
            source: "20260101T000000.000000Z-00000000000000000000000000000000",
          })
        ).pipe(Layer.provide(Layer.succeed(HostShell, shell)))
      )
    );

    return Context.make(HostShell, shell).pipe(
      Context.add(Trace, trace),
      Context.add(UnitStartup, { ...startup, afterStart: () => Effect.void })
    );
  })
).pipe(Layer.provide(NodeServices.layer), Layer.orDie);

const { test } = Test.make({
  providers: Layer.mergeAll(HostDirectoryProvider(), NodeProvider()).pipe(
    Layer.provideMerge(runtime)
  ),
  stage: "restore-order-tests",
});

const program = Effect.gen(function* ownedRestoreGraph() {
  const root = yield* HostDirectory("root", { mode: 0o700, path: dataRoot });

  const data = yield* HostDirectory("data", {
    mode: 0o700,
    path: Output.interpolate`${root.path}/celld`,
    purgeOnDelete: true,
    purgeRoot: dataRoot,
  });

  return yield* NodeResource(
    "node",
    data.path.pipe(
      Output.map((directory) => ({
        ...nodeUnit({
          binary: "/srv/example/celld",
          data: directory,
          environment: `${home}/.config/rat-king/celld.env`,
          host: {
            dataRoot,
            home,
            ssh: "example.invalid",
            tailnetIPv4: "203.0.113.10",
          },
          restartOn: [],
        }),
        internalUrl: "http://127.0.0.1:18788",
        publicUrl: "http://203.0.113.10:18787",
        version: "v0.6.1" as const,
      }))
    )
  );
});

test.provider(
  "resources own mode-0700 directories before extract/import/start without weakening adoption",
  (scratch) =>
    Effect.gen(function* restoreOrder() {
      const stack = checkedStack(scratch);
      yield* stack.deploy(program);
      expect(yield* Ref.get(yield* Trace)).toEqual([
        "extract",
        "import",
        "start",
      ]);
      expect(yield* (yield* HostShell).stat(`${dataRoot}/celld`)).toMatchObject(
        { mode: 0o700 }
      );
      const plan = yield* stack.plan(program);
      expect(
        Object.values(plan.resources).every(
          (resource) => resource.action === "noop"
        )
      ).toBe(true);
      yield* stack.destroy();
    })
);
