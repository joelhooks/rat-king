import * as Cloudflare from "@alchemy.run/cloudflare";
import { localState, Stack } from "alchemy";
import * as Provider from "alchemy/Provider";
import { Config, Effect, Path } from "effect";
import type { Redacted } from "effect";

import { workerBundle } from "../../packages/alchemy-nest/src/worker-bundle.ts";

export const workerProps = (
  hostname: string,
  script: string,
  webhook: Redacted.Redacted,
  pull: Redacted.Redacted
) => ({
  bundle: false,
  compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] },
  domain: hostname,
  env: {
    ALERTS: Cloudflare.DurableObject("ALERTS", { className: "BillingQueue" }),
    BILLING_PULL_CREDENTIAL: pull,
    BILLING_WEBHOOK_CREDENTIAL: webhook,
    RATE_LIMIT: Cloudflare.Workers.RateLimit("RATE_LIMIT", {
      namespaceId: 1001,
      simple: { limit: 10, period: 60 },
    }),
  },
  name: "billing-alert-ingress",
  script,
  workersDev: { enabled: false, previewsEnabled: false },
});

const offlineProvider = Provider.effect(
  Cloudflare.Worker,
  Effect.succeed({
    delete: () => Effect.die("OFFLINE_MUTATION_REFUSED"),
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Provider.read requires undefined (not void) to mean absent.
    read: () => Effect.succeed(undefined),
    reconcile: () => Effect.die("OFFLINE_MUTATION_REFUSED"),
  })
);

export const billingStack = (offline: boolean) =>
  Stack(
    "billing",
    {
      providers: offline ? offlineProvider : Cloudflare.providers(),
      state: localState(),
    },
    Effect.gen(function* billing() {
      const path = yield* Path.Path;
      const hostname = yield* Config.String("RAT_KING_BILLING_HOSTNAME");

      if (
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(hostname)
      ) {
        return yield* Effect.die("Invalid billing hostname");
      }

      const script = yield* workerBundle(
        path.resolve(
          import.meta.dirname,
          "../../apps/billing-ingress/worker.ts"
        )
      );

      const worker = yield* Cloudflare.Worker(
        "ingress",
        workerProps(
          hostname,
          script,
          yield* Config.Redacted("BILLING_WEBHOOK_CREDENTIAL"),
          yield* Config.Redacted("BILLING_PULL_CREDENTIAL")
        )
      );

      return { url: worker.url };
    }).pipe(Effect.orDie)
  );
