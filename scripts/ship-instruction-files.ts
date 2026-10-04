import { Effect, FileSystem, Schema } from "effect";

import { deployConfidence, DeployConfidence } from "./deploy-capabilities.ts";
import {
  checkDeployConfidence,
  updateDeployConfidence,
} from "./deploy-instructions.ts";

export const synchronizeInstructions = Effect.fn("synchronizeInstructions")(
  function* synchronize(root: string, write: boolean) {
    const fs = yield* FileSystem.FileSystem;
    const path = `${root}/skills/ship/SKILL.md`;

    const catalog =
      yield* Schema.decodeEffect(DeployConfidence)(deployConfidence);

    const document = yield* fs.readFileString(path);

    if (write) {
      const rendered = yield* updateDeployConfidence(document, catalog, path);

      if (document !== rendered) {
        yield* fs.writeFileString(path, rendered);
      }
    } else {
      yield* checkDeployConfidence(document, catalog, path);
    }

    return path;
  }
);
