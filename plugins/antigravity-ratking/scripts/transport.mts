// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off newPromise:off -- Installed plugin has no dependencies inside the agent fence. Host IPC is Unix-only.
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, promise/avoid-new -- The installed transport has no dependencies. It checks the JSON-RPC envelope and lets the shared host decode tool arguments. */
import { request } from "node:http";

const protocol = "2025-03-26";

const maximum = 4 * 1024 * 1024;

const socketPath =
  process.env.RATKING_CITIZEN_SOCKET ?? "/run/ratking-citizen/mail.sock";

type JsonObject = Record<string, unknown>;

export const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const connection = (timeout = 6000) => {
  let session: string | undefined;
  let id = 0;

  const exchange = async (message?: JsonObject) =>
    await new Promise<readonly unknown[]>((resolve, reject) => {
      const body = message === undefined ? undefined : JSON.stringify(message);

      if (body !== undefined && Buffer.byteLength(body) > maximum) {
        reject(new Error("Rat King request too large"));

        return;
      }

      const headers = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": protocol,
      };

      if (session !== undefined) {
        Object.assign(headers, { "mcp-session-id": session });
      }

      const req = request(
        {
          headers,
          method: message === undefined ? "DELETE" : "POST",
          path: "/mcp",
          signal: AbortSignal.timeout(timeout),
          socketPath,
        },
        (res) => {
          const next = res.headers["mcp-session-id"];

          if (typeof next === "string") {
            session = next;
          }

          if ((res.statusCode ?? 500) >= 300) {
            res.resume();
            reject(new Error("Rat King host refused the MCP exchange"));

            return;
          }

          let data = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => {
            data += chunk;

            if (data.length > maximum) {
              res.destroy(new Error("Rat King response too large"));
            }
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (data === "") {
                resolve([]);
              } else if (
                res.headers["content-type"]?.startsWith("text/event-stream") ===
                true
              ) {
                resolve(
                  data
                    .split(/\r?\n/u)
                    .filter((line) => line.startsWith("data:"))
                    .map((line): unknown => JSON.parse(line.slice(5)))
                );
              } else {
                const response: unknown = JSON.parse(data);
                resolve([response]);
              }
            } catch (error) {
              reject(
                new Error("Rat King host sent invalid JSON", { cause: error })
              );
            }
          });
        }
      );

      req.on("error", reject);
      req.end(body);
    });

  const query = async (method: string, params: JsonObject) => {
    id += 1;
    const requestId = `citizen-${id}`;

    const responses = await exchange({
      id: requestId,
      jsonrpc: "2.0",
      method,
      params,
    });

    const response = responses
      .filter(object)
      .find((item) => item.id === requestId);

    if (!object(response?.result)) {
      throw new Error("Rat King MCP did not return a result");
    }

    return response.result;
  };

  return {
    call: async (name: string, args: JsonObject = {}) => {
      const result = await query("tools/call", { arguments: args, name });

      if (result.isError === true) {
        throw new TypeError("Rat King tool refused");
      }

      const content: unknown = Array.isArray(result.content)
        ? result.content[0]
        : undefined;

      const answer: unknown =
        result.structuredContent ??
        (object(content) &&
        content.type === "text" &&
        typeof content.text === "string"
          ? JSON.parse(content.text)
          : undefined);

      if (!object(answer)) {
        throw new Error("Missing Rat King tool result");
      }

      return answer;
    },
    close: async () => {
      if (session !== undefined) {
        try {
          await exchange();
        } catch {
          process.stderr.write(
            "Rat King MCP session already closed or unavailable.\n"
          );
        }
      }
    },
    exchange,
    initialize: async () => {
      const result = await query("initialize", {
        capabilities: {},
        clientInfo: { name: "ratking-antigravity", version: "0.1.0" },
        protocolVersion: protocol,
      });

      await exchange({ jsonrpc: "2.0", method: "notifications/initialized" });

      return result;
    },
  };
};
