// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Standalone hook writes only the seat's opaque wake marker.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The standalone hook validates the two external envelopes at its I/O boundary. */

import { connection, object } from "./transport.mts";

const [event] = process.argv.slice(2);

const scope = process.env.RATKING_CITIZEN_WORKSPACE;

const state = process.env.RATKING_CITIZEN_HOOK_STATE;

const notice =
  "Rat King mail is waiting. Use the Rat King inbox tool, handle the ordered batch, then acknowledge only the IDs you finished.";

const run = async (input: unknown) => {
  if (
    scope === undefined ||
    state === undefined ||
    !object(input) ||
    !Array.isArray(input.workspacePaths) ||
    !input.workspacePaths.includes(scope) ||
    typeof input.conversationId !== "string" ||
    !/^[a-f0-9-]{36}$/iu.test(input.conversationId)
  ) {
    return {};
  }

  if (
    event !== "start" &&
    (event !== "stop" ||
      input.fullyIdle !== true ||
      input.terminationReason !== "model_stop" ||
      (typeof input.error === "string" && input.error !== ""))
  ) {
    return {};
  }

  const host = connection(1800);

  try {
    await host.initialize();
    const peek = await host.call("wake");

    if (
      typeof peek.batch !== "string" ||
      (event === "stop" && peek.wakes !== true)
    ) {
      return {};
    }

    await mkdir(state, { mode: 0o700, recursive: true });
    const marker = path.join(state, input.conversationId);

    const prior = await readFile(marker, "utf-8").catch((error: unknown) => {
      if (!object(error) || error.code !== "ENOENT") {
        throw error;
      }

      return "";
    });

    if (prior === peek.batch) {
      return {};
    }

    const temporary = `${marker}.${process.pid}`;
    await writeFile(temporary, peek.batch, { flag: "wx", mode: 0o600 });
    await rename(temporary, marker);

    return event === "start"
      ? { injectSteps: [{ systemMessage: { systemMessage: notice } }] }
      : { decision: "continue", reason: notice };
  } finally {
    await host.close();
  }
};

try {
  let input = "";
  process.stdin.setEncoding("utf-8");

  // SAFETY: setEncoding above makes this stream yield strings.
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    input += chunk;

    if (input.length > 128 * 1024) {
      throw new Error("Oversized hook input");
    }
  }

  const payload: unknown = JSON.parse(input);
  process.stdout.write(`${JSON.stringify(await run(payload))}\n`);
} catch {
  process.stderr.write(
    "Rat King hook could not inspect the seat; no mail was acknowledged.\n"
  );
  process.stdout.write("{}\n");
}
