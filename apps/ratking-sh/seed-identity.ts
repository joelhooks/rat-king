/* oxlint-disable typescript/promise-function-async -- Lazy fetch boundary for Effect.tryPromise. */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Operator CLI reads the public plan and the local signer's stdin.
import { readFileSync } from "node:fs";

import { Console, Effect, Option, Schema } from "effect";

import { issuerConfig } from "./src/identity/admin.ts";
import {
  importIssuer,
  SeedFailure,
  seedIdentity,
  SeedPlan,
} from "./src/identity/seed.ts";

const seed = Effect.gen(function* runSeed() {
  const [planFile] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.String])
  )(process.argv.slice(2)).pipe(
    Effect.mapError(
      () =>
        new SeedFailure({
          reason:
            "Usage: node apps/ratking-sh/seed-identity.ts <public-plan.json> < <issuer-identity-json>",
        })
    )
  );

  const pin = yield* issuerConfig.pipe(
    Effect.mapError(
      () =>
        new SeedFailure({
          reason: "Invalid RATKING_IDENTITY_ISSUER public pin",
        })
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          new SeedFailure({
            reason: "Set RATKING_IDENTITY_ISSUER to the deployed public pin",
          }),
        onSome: Effect.succeed,
      })
    )
  );

  const planText = yield* Effect.try({
    catch: () => new SeedFailure({ reason: "Cannot read public seed plan" }),
    try: () => readFileSync(planFile, "utf-8"),
  });

  const plan = yield* Schema.decodeEffect(SeedPlan, {
    onExcessProperty: "error",
  })(planText).pipe(
    Effect.mapError(
      () => new SeedFailure({ reason: "Invalid public seed plan" })
    )
  );

  const secret = yield* Effect.try({
    catch: () =>
      new SeedFailure({ reason: "Cannot read signing identity from stdin" }),
    try: () => readFileSync(0, "utf-8"),
  });

  const signingKey = yield* importIssuer(secret, pin);

  const verified = yield* seedIdentity({
    pin,
    plan,
    send: (request) =>
      Effect.tryPromise({
        catch: () =>
          new SeedFailure({
            reason: `Request to ${new URL(request.url).hostname} failed; read state before retrying`,
          }),
        try: (signal) =>
          // @effect-diagnostics-next-line globalFetchInEffect:off -- Preserve the signed request verbatim and never follow redirects.
          fetch(request, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          }),
      }),
    signingKey,
  });

  yield* Console.log(
    `DID readback verified: ${verified.join(", ")}. Check handle DNS and HTTPS separately.`
  );
});

await Effect.runPromise(
  seed.pipe(
    Effect.catchTag("SeedFailure", ({ reason }) =>
      Console.error(reason).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            process.exitCode = 1;
          })
        )
      )
    )
  )
);
