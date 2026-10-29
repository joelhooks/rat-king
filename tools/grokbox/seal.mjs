#!/usr/bin/env node
import { seal } from "./bootstrap.ts";

try {
  process.stdout.write(
    `${JSON.stringify(await seal(process.argv.slice(2)))}\n`
  );
} catch {
  process.stderr.write(
    "seal: refused; supply a public DID document path and nonempty stdin.\n"
  );
  process.exitCode = 1;
}
