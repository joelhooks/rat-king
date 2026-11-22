import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  secretSource,
  systemdCredential,
} from "../../ratking-client/src/systemd-credentials.ts";
import { HostError } from "./host-error.ts";

export const SecretName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u)
);

export const SecretRef = Schema.Struct({ secret: SecretName });

export interface Secrets {
  readonly resolve: (
    ref: typeof SecretRef.Type
  ) => Effect.Effect<Redacted.Redacted, HostError>;
}

const unavailable = (secret: string) =>
  new HostError({
    operation: "secret lease",
    reason: `Secret unavailable: ${secret}`,
  });

export class SecretSource extends Context.Service<SecretSource, Secrets>()(
  "@rat-king/alchemy-nest/SecretSource"
) {
  static readonly layer = Layer.effect(
    SecretSource,
    Effect.gen(function* makeSecretSource() {
      const source = yield* secretSource.pipe(Effect.orElseSucceed(() => null));

      if (source === "systemd") {
        return SecretSource.of({
          resolve: (ref) =>
            systemdCredential(ref.secret).pipe(
              Effect.mapError(() => unavailable("systemd credential"))
            ),
        });
      }

      if (source === null) {
        return SecretSource.of({
          resolve: () => Effect.fail(unavailable("invalid source")),
        });
      }

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      return SecretSource.of({
        resolve: Effect.fn("SecretSource.resolve")(
          function* resolve(ref) {
            if (!Schema.is(SecretRef)(ref)) {
              return yield* unavailable("invalid name");
            }

            yield* Effect.logInfo(`secret lease: ${ref.secret} (ttl 5m)`);

            const handle = yield* spawner.spawn(
              ChildProcess.make(
                "secrets",
                [
                  "lease",
                  ref.secret,
                  "--ttl",
                  "5m",
                  "--client-id",
                  "rat-king-nest",
                ],
                { stderr: "ignore", stdin: "ignore" }
              )
            );

            const [code, chunks] = yield* Effect.all(
              [handle.exitCode, Stream.runCollect(handle.stdout)],
              { concurrency: "unbounded" }
            );

            const text = Buffer.concat(chunks).toString("utf-8");

            if (Number(code) !== 0 || text === "") {
              return yield* unavailable(ref.secret);
            }

            return Redacted.make(text);
          },
          Effect.scoped,
          (effect, ref) =>
            effect.pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(() => unavailable(ref.secret))
            )
        ),
      });
    })
  );

  static readonly fromRecord = (values: Readonly<Record<string, string>>) =>
    Layer.succeed(SecretSource, {
      resolve: Effect.fn("SecretSource.test.resolve")(function* resolve(
        ref: typeof SecretRef.Type
      ) {
        const value = values[ref.secret];

        if (!Schema.is(SecretRef)(ref) || value === undefined || value === "") {
          return yield* unavailable(ref.secret);
        }

        return Redacted.make(value);
      }),
    });
}
