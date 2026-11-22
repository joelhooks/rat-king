import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { Effect, Schema } from "effect";

import {
  AbsolutePath,
  readBoundedRegularFile,
} from "../../packages/alchemy-nest/src/files.ts";
import {
  decodePrepared,
  maxPreparedBytes,
  Sha256,
} from "./prepared-payload.ts";
import { run } from "./runtime.ts";
import type { PreparedRuntimePorts } from "./runtime.ts";
import { Sha } from "./ship-config.ts";
import {
  FleetError,
  loadStageConfig,
  preparedStageProvider,
} from "./stage-config.ts";

const Args = Schema.Tuple([AbsolutePath, Sha, Sha256]);

export const preparedApply = (
  args: readonly string[],
  ports: PreparedRuntimePorts = {}
) =>
  Effect.gen(function* apply() {
    const [file, commit, sha256] = yield* Schema.decodeUnknownEffect(Args)(
      args
    ).pipe(
      Effect.mapError(
        () =>
          new FleetError({
            reason: "Usage: prepared-apply <absolute-file> <sha> <sha256>",
          })
      )
    );

    const config = yield* loadStageConfig;

    if (
      config.shipAttempt?.sha !== commit ||
      config.runtime.RAT_KING_COMMIT !== commit
    ) {
      return yield* new FleetError({
        reason: "Prepared apply attempt SHA refused",
      });
    }

    const bytes = yield* readBoundedRegularFile(file, maxPreparedBytes);
    const payload = yield* decodePrepared(bytes, { commit, sha256 });

    if (payload.version !== config.runtime.RAT_KING_VERSION) {
      return yield* new FleetError({
        reason: "Prepared apply attempt version refused",
      });
    }

    return yield* run("deploy", payload, ports).pipe(
      Effect.provide(preparedStageProvider(config))
    );
  });

if (import.meta.main) {
  NodeRuntime.runMain(
    preparedApply(process.argv.slice(2)).pipe(
      Effect.provide([NodeServices.layer, AuthProvidersLive])
    )
  );
}
