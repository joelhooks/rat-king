import { localState, Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, FileSystem, Path } from "effect";

import { hostedBindings, hostedVars } from "../../apps/mailbox/src/bindings.ts";
import { prepareDeployment } from "../../packages/alchemy-nest/src/deployment-build.ts";
import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { assertFaux, externalFile, readIdentity } from "./inputs.ts";
import { projectWorker } from "./projection.ts";

export const preview = Stack(
  "cf",
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* preview() {
    yield* Effect.try({
      catch: () => refuse("Preview forbids gateway and sidecar inputs"),
      try: () => {
        assertFaux(process.env);
      },
    }).pipe(Effect.orDie);

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostedDid = yield* Config.String("RAT_KING_REMOTE_DID");

    const documents = yield* fs.readFileString(
      yield* externalFile(yield* Config.String("RAT_KING_DOCUMENTS"))
    );

    const identity = yield* readIdentity(hostedDid);

    const prepared = yield* prepareDeployment(
      path.resolve(
        import.meta.dirname,
        "../../apps/mailbox/src/hosted-worker.ts"
      ),
      hostedBindings,
      {
        commit: yield* Config.String("RAT_KING_COMMIT"),
        vars: hostedVars({
          documents,
          gatewayModel: "",
          gatewayUrl: "",
          hostedDid,
          model: "faux",
          serviceDid: yield* Config.String("RAT_KING_SERVICE_DID"),
          sidecar: false,
        }),
        version: yield* Config.String("RAT_KING_VERSION"),
      }
    );

    const worker = yield* Cloudflare.Worker(
      "mailbox",
      projectWorker(hostedBindings, prepared, identity)
    );

    return {
      commit: prepared.commit,
      version: prepared.version,
      workerUrl: worker.url,
    };
  }).pipe(Effect.orDie)
);
