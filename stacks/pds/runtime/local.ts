/* oxlint-disable anti-slop/no-runtime-typeof -- Distinguish Node TCP addresses and decode untrusted JSON at the XRPC boundary. */
import { createECDH, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import { runPds } from "./server.ts";

export const localIdentity = () => {
  const key = createECDH("secp256k1");

  key.generateKeys();

  return {
    rotationPublicKey: key.getPublicKey("hex", "compressed"),
    secrets: {
      admin: randomBytes(32).toString("hex"),
      jwt: randomBytes(32).toString("hex"),
      rotation: key.getPrivateKey().toString("hex").padStart(64, "0"),
    },
  };
};

export const withPds = async <T>(
  options: Omit<Parameters<typeof runPds>[0], "port" | "onStarted" | "signal">,
  use: (origin: string) => Promise<T>
): Promise<T> => {
  const ready = Promise.withResolvers<AddressInfo>();
  const stop = new AbortController();

  const running = runPds({
    ...options,
    onStarted: ({ server }) => {
      const address = server?.address();

      if (
        address === undefined ||
        address === null ||
        typeof address === "string" ||
        address.address !== "127.0.0.1"
      ) {
        ready.reject(new Error("PDS did not open a loopback-only listener."));
      } else {
        ready.resolve(address);
      }
    },
    port: 0,
    signal: stop.signal,
  });

  const earlyExit = async () => {
    await running;
    throw new Error("PDS exited before opening its listener.");
  };

  try {
    const address = await Promise.race([ready.promise, earlyExit()]);

    return await use(`http://127.0.0.1:${address.port}`);
  } finally {
    stop.abort();
    await running;
  }
};

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- This smoke-client adapter decodes small XRPC responses before the assertion helpers use them. */
export const field = (value: unknown, name: string): unknown =>
  value !== null && typeof value === "object" && Object.hasOwn(value, name)
    ? // oxlint-disable-next-line anti-slop/no-reflect-get -- Read an own JSON member as unknown for field-specific validation.
      Reflect.get(value, name)
    : undefined;

export const textField = (value: unknown, name: string): string => {
  const text = field(value, name);

  if (typeof text !== "string" || text.length === 0) {
    throw new Error(`Missing response field ${name}.`);
  }

  return text;
};

export const xrpc = async (
  origin: string,
  method: string,
  input?: {
    readonly query?: Record<string, string>;
    readonly body?: unknown;
    readonly authorization?: string;
  }
): Promise<unknown> => {
  const url = new URL(`/xrpc/${method}`, origin);
  const headers = new Headers();

  if (input?.query !== undefined) {
    url.search = new URLSearchParams(input.query).toString();
  }

  if (input?.authorization !== undefined) {
    headers.set("Authorization", input.authorization);
  }

  if (input?.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    body: input?.body === undefined ? null : JSON.stringify(input.body),
    headers,
    method: input?.body === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(10_000),
  });

  const result: unknown = await response.json();

  if (!response.ok) {
    const error = field(result, "error");

    throw new Error(
      `${method} returned ${response.status}: ${typeof error === "string" ? error : "no XRPC error code"}`
    );
  }

  return result;
};

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

export const getLexicon = async (origin: string, did: string, nsid: string) => {
  const result = await xrpc(origin, "com.atproto.repo.getRecord", {
    query: { collection: "com.atproto.lexicon.schema", repo: did, rkey: nsid },
  });

  const value = field(result, "value");

  if (
    field(result, "uri") !== `at://${did}/com.atproto.lexicon.schema/${nsid}` ||
    field(value, "id") !== nsid ||
    field(value, "lexicon") !== 1 ||
    field(value, "$type") !== "com.atproto.lexicon.schema"
  ) {
    throw new Error(
      "PDS getRecord did not return the requested Lexicon schema."
    );
  }

  return { cid: textField(result, "cid"), value };
};
