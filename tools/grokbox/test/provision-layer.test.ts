// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Scratch state and the fetch stub sit at the test edge.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { afterEach, expect, vi } from "vitest";

import { mintHost } from "../bootstrap.ts";
import { provision, provisioningLayer } from "../provision.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

it.live("provision runs through the exported provisioningLayer", () =>
  Effect.gen(function* proof() {
    const root = mkdtempSync(path.join(tmpdir(), "grokbox-layer-"));
    const secrets = path.join(root, "secrets");
    const config = path.join(root, "pi.json");

    writeFileSync(
      config,
      JSON.stringify({
        didTemplate: "did:web:{agent}.agents.example.invalid",
        endpoint: "https://mailbox.example.invalid",
        issuer: { endpoint: "https://issuer.example.invalid", host: "host1" },
        secretsCommand: path.resolve(import.meta.dirname, "../secrets.mjs"),
        serviceDid: "did:web:mailbox.example.invalid",
        state: path.join(root, "state"),
      })
    );

    process.env.HOME = root;
    process.env.RATKING_CONFIG = config;
    process.env.RATKING_SECRETS_DIR = secrets;

    yield* Effect.promise(
      async () => await mintHost(["did:web:host.example.invalid", "host1"])
    );

    const registered: string[] = [];

    const Body = Schema.fromJsonString(
      Schema.Struct({ document: Schema.Struct({ id: Schema.String }) })
    );

    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      const body = Schema.decodeUnknownSync(Body)(
        await new Request(url, init).text()
      );

      registered.push(body.document.id);

      return Response.json({ did: body.document.id });
    });

    const name = "grokbot/layer1";

    expect(
      yield* provision(name).pipe(Effect.provide(provisioningLayer))
    ).toEqual({ did: "did:web:grokbot.layer1.agents.example.invalid", name });
    expect(registered).toEqual([
      "did:web:grokbot.layer1.agents.example.invalid",
    ]);
  })
);
