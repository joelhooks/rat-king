import { Config, Effect, Result, Schema } from "effect";

import { readFile } from "../../packages/alchemy-nest/src/files.ts";
import { HostShell } from "../../packages/alchemy-nest/src/host-shell.ts";
import { Host } from "../../packages/alchemy-nest/src/host.ts";
import { weedBinary } from "../../packages/alchemy-nest/src/pins.ts";
import { binaryDigest } from "../../packages/alchemy-nest/src/release.ts";
import { fleetCelldBinary } from "./celld-build.ts";
import { connection } from "./nest-connection.ts";
import { FleetError } from "./stage-config.ts";

export const preparedBinaries = Effect.gen(function* preparedBinaries() {
  const node = yield* (yield* Host).node(
    yield* Config.String("RAT_KING_LIVE_NODE")
  );

  const shell = yield* HostShell;
  const bin = `${node.home}/.local/share/rat-king/bin`;

  const expected = [
    { ...fleetCelldBinary(node.home), path: `${bin}/celld` },
    weedBinary(`${bin}/weed`),
  ];

  const missing: string[] = [];

  for (const props of expected) {
    const file = yield* readFile(shell, props.path).pipe(Effect.result);

    if (
      Result.isFailure(file) ||
      file.success?.sha256 !== binaryDigest(props) ||
      file.success.mode !== 0o755
    ) {
      missing.push(props.path);
    }
  }

  if (missing.length > 0) {
    return yield* new FleetError({
      reason: `ArtifactMissing: stage pinned executables (0755): ${missing.join(", ")}`,
    });
  }

  return yield* Effect.void;
}).pipe(
  Effect.provide(connection),
  Effect.timeout("30 seconds"),
  Effect.mapError((cause) =>
    Schema.is(FleetError)(cause)
      ? cause
      : new FleetError({ reason: "ArtifactPreflightUnavailable" })
  )
);
