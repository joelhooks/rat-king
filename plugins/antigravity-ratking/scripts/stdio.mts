// @effect-diagnostics asyncFunction:off -- Standalone CLI adapter runs inside the fence without workspace dependencies.
import { createInterface } from "node:readline";

import { connection, object } from "./transport.mts";

const [name] = process.argv.slice(2);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Forward opaque upstream protocol responses verbatim, not tool input.
const write = (message: unknown) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);

if (name === undefined || !/^[a-z0-9][a-z0-9._/-]*$/u.test(name)) {
  process.stderr.write(
    "Configure the exact provisioned Rat King name before enabling this plugin.\n"
  );
  process.exitCode = 2;
} else {
  let host = connection(50_000);

  const checkName = async () => {
    const identity = await host.call("whoami");

    if (identity.name !== name) {
      throw new Error(
        "Configured name does not match the socket's host reader"
      );
    }
  };

  try {
    const init = await host.initialize();
    await checkName();

    const lines = createInterface({
      crlfDelay: Infinity,
      input: process.stdin,
    });

    for await (const line of lines) {
      if (line.trim() === "") {
        continue;
      }

      const message: unknown = JSON.parse(line);

      if (!object(message)) {
        continue;
      }

      if (message.method === "initialize") {
        write({ id: message.id, jsonrpc: "2.0", result: init });
      } else if (message.method !== "notifications/initialized") {
        try {
          try {
            await checkName();
          } catch {
            await host.close();
            host = connection(50_000);
            await host.initialize();
            await checkName();
          }

          for (const response of await host.exchange(message)) {
            write(response);
          }
        } catch {
          if (message.id !== undefined) {
            write({
              error: {
                code: -32_000,
                message:
                  "Rat King host exchange failed. Reconcile uncertain mail; do not blindly resend.",
              },
              id: message.id,
              jsonrpc: "2.0",
            });
          }
        }
      }
    }
  } catch {
    process.stderr.write(
      "Rat King stdio could not establish the configured seat. Check the host socket and provisioned name.\n"
    );
    process.exitCode = 1;
  } finally {
    await host.close();
  }
}
