import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option, Schema } from "effect";
import { initialTransition } from "xstate";

import { mailboxManifest } from "../../../../stacks/nest/prepared-manifest.ts";
import { execute } from "../../../../stacks/nest/ship-command.ts";
import { shipMachine } from "../../../../stacks/nest/ship-machine.ts";
import { shipCycle } from "../../../../stacks/nest/ship.ts";

const child = `import { writeFileSync } from 'node:fs';
const [folder] = process.argv.slice(1);
process.on('SIGTERM', () => { writeFileSync(folder + '/child-stopped', 'yes'); process.exit(0); });
writeFileSync(folder + '/child-ready', 'yes');
setInterval(() => {}, 30_000);`;

const program = Effect.gen(function* run() {
  const [root] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.String])
  )(process.argv.slice(2));

  const fs = yield* FileSystem.FileSystem;
  const commit = "a".repeat(40);
  const live = "b".repeat(40);
  const older = "c".repeat(40);

  const [initial] = initialTransition(shipMachine, {
    failed: "",
    successful: live,
  });

  const snapshot = yield* shipCycle(initial, {
    checkpoint: (state) =>
      fs
        .writeFileString(`${root}/checkpoint`, JSON.stringify(state))
        .pipe(Effect.orDie),
    deployPrepared: () =>
      execute(
        process.execPath,
        ["--input-type=module", "--eval", child, root],
        root
      ).pipe(Effect.andThen(Effect.die("child unexpectedly exited"))),
    notify: () => Effect.void,
    record: (receipt) =>
      fs
        .writeFileString(`${root}/receipt`, JSON.stringify(receipt))
        .pipe(Effect.orDie),
    recover: Effect.succeed("running"),
    select: () =>
      Effect.succeed(
        Option.some({
          ahead: [commit, older],
          payload: {
            backup: "fixture",
            cli: "fixture",
            commit,
            manifest: mailboxManifest,
            restart: "fixture",
            version: "1.0.0",
            worker: "fixture",
          },
        })
      ),
  });

  return snapshot.value;
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
