#!/usr/bin/env node
import { runSecrets } from "./private-store.ts";

try {
  runSecrets(process.argv.slice(2));
} catch {
  process.stderr.write(
    "secrets: refused; check command, name, private file modes, and whether the key already exists. Never replaces keys.\n"
  );
  process.exitCode = 1;
}
