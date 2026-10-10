import { Effect, Layer } from "effect";

import { CliError } from "../identity.ts";
import { SecretStore } from "../secrets.ts";

export const memorySecretStoreLayer = Layer.sync(SecretStore, () => {
  const entries = new Map<string, string>();

  return SecretStore.of({
    add: Effect.fn("SecretStore.Test.add")((name, value) =>
      Effect.suspend(() => {
        if (entries.has(name)) {
          return Effect.fail(new CliError({ reason: "Secret already exists" }));
        }

        entries.set(name, value);

        return Effect.void;
      })
    ),
    exists: Effect.fn("SecretStore.Test.exists")((name) =>
      Effect.sync(() => entries.has(name))
    ),
    lease: Effect.fn("SecretStore.Test.lease")((name) =>
      Effect.suspend(() => {
        const value = entries.get(name);

        return value === undefined
          ? Effect.fail(new CliError({ reason: "Secret not found" }))
          : Effect.succeed(value);
      })
    ),
  });
});
