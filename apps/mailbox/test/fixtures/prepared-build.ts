import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Schema } from "effect";

import { digest } from "../../../../packages/alchemy-nest/src/files.ts";
import { buildFleetModules } from "../../../../packages/alchemy-nest/src/fleet-build.ts";
import { encodePrepared } from "../../../../stacks/nest/prepared-payload.ts";
import { Sha } from "../../../../stacks/nest/ship-config.ts";

const program = Effect.gen(function* fixtureBuild() {
  const [root, commit, origin] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.NonEmptyString, Sha, Schema.NonEmptyString])
  )(process.argv.slice(2));

  const version = "1.2.3";
  const payloads = yield* buildFleetModules(root, { commit, version });
  const home = process.env.HOME ?? "";
  const bytes = encodePrepared({ ...payloads, commit, version });
  const wire = new TextDecoder().decode(bytes);

  const leak = Object.entries({ home, origin, root }).find(
    ([, path]) => path !== "" && wire.includes(path)
  );

  if (leak !== undefined) {
    const [label, path] = leak;
    const index = wire.indexOf(path);

    const excerpt = wire
      .slice(Math.max(0, index - 90), index + path.length + 90)
      .replaceAll(path, "<root>");

    return yield* Effect.die(`Builder leaked ${label}: ${excerpt}`);
  }

  return yield* Console.log(digest(bytes));
});

NodeRuntime.runMain(program);
