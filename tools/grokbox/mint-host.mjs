#!/usr/bin/env node
import { mintHost } from "./bootstrap.ts";

try {
  process.stdout.write(
    `${JSON.stringify(await mintHost(process.argv.slice(2)))}\n`
  );
} catch {
  process.stderr.write(
    "mint-host: refused; supply a DID and a new secret name. Existing keys are never replaced.\n"
  );
  process.exitCode = 1;
}
