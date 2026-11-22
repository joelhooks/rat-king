// @effect-diagnostics nodeBuiltinImport:off -- The operator CLI is the process boundary to agent-secrets.
import { spawn } from "node:child_process";

import { Context, Effect, Layer, Predicate, Redacted, Schema } from "effect";

import {
  secretSource,
  systemdCredential,
} from "../../../packages/ratking-client/src/systemd-credentials.ts";
import { CliError } from "./identity.ts";

export class SecretStore extends Context.Service<
  SecretStore,
  {
    readonly exists: (name: string) => Effect.Effect<boolean, CliError>;
    readonly lease: (name: string) => Effect.Effect<string, CliError>;
    readonly add: (
      name: string,
      value: string
    ) => Effect.Effect<void, CliError>;
  }
>()("MailboxCli/SecretStore") {}

export const secretCommand = (args: readonly string[], input?: string) =>
  Effect.callback<string, CliError>((resume) => {
    const child = spawn("secrets", ["--no-update-check", ...args], {
      stdio: ["pipe", "pipe", "ignore"],
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();

      if (output.length > 16_777_216) {
        child.kill("SIGTERM");
        resume(
          Effect.fail(new CliError({ reason: "Secret-store output too large" }))
        );
      }
    });
    child.on("error", () => {
      resume(
        Effect.fail(new CliError({ reason: "Secret-store CLI unavailable" }))
      );
    });
    child.stdin.on("error", () => {
      resume(
        Effect.fail(new CliError({ reason: "Secret-store stdin failed" }))
      );
    });
    child.on("exit", (code) => {
      resume(
        code === 0
          ? Effect.succeed(output)
          : Effect.fail(
              new CliError({ reason: "Secret-store command refused" })
            )
      );
    });
    child.stdin.end(input);

    return Effect.sync(() => {
      child.kill("SIGTERM");
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(new CliError({ reason: "Secret-store command timed out" })),
    })
  );

const Listing = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({
    secrets: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
});

export interface SecretOptions {
  readonly config?: string;
  readonly socket?: string;
}

const legacySecretStore = (options: SecretOptions) => {
  const flags = [
    ...(options.config === undefined ? [] : ["--config", options.config]),
    ...(options.socket === undefined ? [] : ["--socket", options.socket]),
  ];

  return SecretStore.of({
    add: Effect.fn("SecretStore.add")((name, value) =>
      secretCommand([...flags, "add", name], value).pipe(Effect.asVoid)
    ),
    exists: Effect.fn("SecretStore.exists")((name) =>
      secretCommand([...flags, "list"]).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Listing))
        ),
        Effect.map((listing) =>
          listing.result.secrets.some((secret) => secret.name === name)
        ),
        Effect.mapError(
          (failure) =>
            new CliError({
              reason: `Cannot list agent-secrets: ${Predicate.isTagged(failure, "CliError") ? failure.reason : "listing did not decode"}`,
            })
        )
      )
    ),
    lease: Effect.fn("SecretStore.lease")((name) =>
      secretCommand([
        ...flags,
        "lease",
        name,
        "--ttl",
        "1m",
        "--client-id",
        "rat-king-provision",
      ])
    ),
  });
};

const systemdLease = (name: string) =>
  systemdCredential(name).pipe(
    Effect.map(Redacted.value),
    Effect.mapError(({ reason }) => new CliError({ reason }))
  );

const systemdStore = SecretStore.of({
  add: () =>
    Effect.fail(new CliError({ reason: "Systemd credentials are read only" })),
  exists: (name) => systemdLease(name).pipe(Effect.isSuccess),
  lease: systemdLease,
});

const refusedStore = (reason: string) => {
  const refuse = () => Effect.fail(new CliError({ reason }));

  return SecretStore.of({ add: refuse, exists: refuse, lease: refuse });
};

export const secretStoreLayer = (options: SecretOptions = {}) =>
  Layer.effect(
    SecretStore,
    Effect.gen(function* selectSecretStore() {
      const source = yield* secretSource.pipe(Effect.orElseSucceed(() => null));

      if (source === "agent-secrets") {
        return legacySecretStore(options);
      }

      if (source === null) {
        return refusedStore("Invalid secret source");
      }

      return options.config === undefined && options.socket === undefined
        ? systemdStore
        : refusedStore(
            "Systemd credentials do not accept legacy store options"
          );
    })
  );
