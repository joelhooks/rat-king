#!/usr/bin/env node
import { Effect } from "effect";

import { provision, provisioningLayer } from "./provision.ts";

const [name, flag, prefix, ...extra] = process.argv.slice(2);

if (
  !name ||
  (flag !== undefined && flag !== "--prefix") ||
  (flag && !prefix) ||
  extra.length > 0
) {
  process.stderr.write(
    "usage: node tools/grokbox/provision.mjs <name> [--prefix grokbot/]\n"
  );
  process.exitCode = 2;
} else {
  await Effect.runPromise(
    provision(name, prefix).pipe(
      Effect.provide(provisioningLayer),
      Effect.match({
        onFailure: () => {
          process.stderr.write(
            "provision: refused; check prefix, existing key, service issuer, and configuration. An issuer failure can leave a local key; ask the operator to recover it, never replace it.\n"
          );
          process.exitCode = 1;
        },
        onSuccess: (result) => {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        },
      })
    )
  );
}
