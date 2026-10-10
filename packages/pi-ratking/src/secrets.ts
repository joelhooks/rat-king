/* oxlint-disable eslint/max-classes-per-file -- Effect service and Schema contracts share their owning port. */
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { Settings } from "./config.ts";
import { runCommand } from "./process.ts";

export class SecretError extends Schema.TaggedError<SecretError>()(
  "SecretError",
  { reason: Schema.String }
) {}

export class SecretStore extends Context.Service<
  SecretStore,
  {
    readonly exists: (name: string) => Effect.Effect<boolean, SecretError>;
    readonly lease: (
      name: string
    ) => Effect.Effect<Redacted.Redacted, SecretError>;
    readonly add: (
      name: string,
      value: Redacted.Redacted
    ) => Effect.Effect<void, SecretError>;
  }
>()("pi-ratking/SecretStore") {}

const Listing = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({
    secrets: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
});

export const secretStoreLayer = Layer.effect(
  SecretStore,
  Effect.gen(function* makeSecretStore() {
    const settings = yield* Settings;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const run = (reason: string, args: readonly string[], input?: string) =>
      runCommand(
        [settings.secretsCommand, "--no-update-check", ...args],
        input === undefined ? undefined : new TextEncoder().encode(input)
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(() => new SecretError({ reason })),
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(new SecretError({ reason }))
        )
      );

    return SecretStore.of({
      add: Effect.fn("SecretStore.add")(function* add(name, value) {
        yield* run(
          "Secret store refused the new identity",
          ["add", name],
          Redacted.value(value)
        );
      }),
      exists: Effect.fn("SecretStore.exists")(function* exists(name) {
        const listing = yield* Schema.decodeEffect(
          Schema.fromJsonString(Listing)
        )(yield* run("Cannot list the secret store", ["list"])).pipe(
          Effect.mapError(
            () =>
              new SecretError({ reason: "Cannot read the secret store list" })
          )
        );

        return listing.result.secrets.some((secret) => secret.name === name);
      }),
      lease: Effect.fn("SecretStore.lease")(function* lease(name) {
        return Redacted.make(
          yield* run("Secret store refused the identity lease", [
            "lease",
            name,
            "--ttl",
            "1m",
            "--client-id",
            "pi-ratking",
          ])
        );
      }),
    });
  })
);
