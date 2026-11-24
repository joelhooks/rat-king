import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import { Effect, Schema } from "effect";

import { boardHost, identityZone, pdsHost } from "./identity/names.ts";

export const CustomDomainHosts = Schema.fromJsonString(
  Schema.Array(
    Schema.String.check(
      Schema.isMaxLength(253),
      Schema.isPattern(
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ratking\.dev$/u
      )
    )
  )
);

export const bindIdentityRoutes = Effect.fn("Edge.bindIdentityRoutes")(
  function* bind({
    protectedHosts,
    script,
    zoneId,
  }: {
    readonly protectedHosts: readonly string[];
    readonly script: Output.Output<string>;
    readonly zoneId: string | Output.Output<string>;
  }) {
    const bypasses = yield* Effect.forEach(
      [
        ...[...new Set([boardHost, pdsHost, ...protectedHosts])]
          .toSorted()
          .map((host) => ({ id: `Bypass-${host}`, pattern: `${host}/*` })),
        { id: "BypassPdsWildcard", pattern: `*.${pdsHost}/*` },
      ],
      ({ id, pattern }) =>
        Cloudflare.Workers.WorkerRoute(id, { pattern, zoneId })
    );

    const apex = yield* Cloudflare.Workers.WorkerRoute("IdentityApex", {
      pattern: `${identityZone}/*`,
      script,
      zoneId,
    });

    const scriptAfterBypasses = Output.all(
      script,
      ...bypasses.map(({ routeId }) => routeId)
    ).pipe(Output.map(([name]) => name));

    yield* Cloudflare.Workers.WorkerRoute("IdentityWildcard", {
      pattern: `*.${identityZone}/*`,
      script: scriptAfterBypasses,
      zoneId,
    });

    return apex.url;
  }
);
