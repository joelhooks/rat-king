#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- Refuse symlinked or public socket parents before starting the host adapter.
import { lstatSync } from "node:fs";
import path from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { AgentName } from "@rat-king/ratking-client/name";
import { Effect, Layer, Schema } from "effect";

import { citizenServer } from "../src/citizen.ts";

const [as, name, at, socket, extra] = process.argv.slice(2);

const privateParent = (socketPath: string) => {
  try {
    const parent = lstatSync(path.dirname(socketPath));

    return (
      parent.isDirectory() &&
      parent.uid === process.getuid?.() &&
      parent.mode % 0o1000 === 0o700
    );
  } catch {
    return false;
  }
};

if (
  as !== "--as" ||
  !Schema.is(AgentName)(name) ||
  at !== "--socket" ||
  socket === undefined ||
  extra !== undefined ||
  !path.isAbsolute(socket) ||
  !privateParent(socket)
) {
  process.stderr.write(
    "Usage: ratking-citizen --as <provisioned-name> --socket <absolute socket path in an owned 0700 directory>\n"
  );
  process.exitCode = 2;
} else {
  process.umask(0o077);
  NodeRuntime.runMain(
    Layer.launch(citizenServer(name, socket)).pipe(
      Effect.tapCause(() =>
        Effect.sync(() => {
          process.stderr.write(
            "Rat King citizen could not start. Check the provisioned name, host configuration and socket ownership.\n"
          );
        })
      )
    ),
    { disableErrorReporting: true }
  );
}
