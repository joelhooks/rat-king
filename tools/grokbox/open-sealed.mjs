#!/usr/bin/env node
import { openSealed } from "./bootstrap.ts";

try {
  await openSealed(process.argv.slice(2));
  process.stdout.write("opened into a new 0600 file\n");
} catch {
  process.stderr.write(
    "open-sealed: refused; check blob, host secret, and a new output path. No key material is printed.\n"
  );
  process.exitCode = 1;
}
