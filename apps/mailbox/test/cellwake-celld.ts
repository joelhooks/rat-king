// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off globalDate:off globalFetch:off globalProcess:off globalConsole:off cryptoRandomUUID:off -- Local process harness, not Worker code.
/* oxlint-disable eslint/no-await-in-loop -- Cursor pages, readiness and startup evidence are ordered. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import { Effect, Schema } from "effect";

import { serviceToken } from "../../../packages/mailbox-client/src/auth.ts";

const [celld, esbuild] = [process.env.CELLD_BIN, process.env.ESBUILD_BIN];

assert.ok(
  celld !== undefined && esbuild !== undefined,
  "Set CELLD_BIN and ESBUILD_BIN to absolute executable paths"
);

const work = await mkdtemp(path.join(tmpdir(), "cellwake-proof-"));

const operator = "did:web:operator.example.invalid";

const service = "did:web:mail.example.invalid";

const keyId = `${operator}#atproto`;

const generated = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

const pair = Schema.decodeUnknownSync(
  Schema.Struct({
    privateKey: Schema.instanceOf(CryptoKey),
    publicKey: Schema.instanceOf(CryptoKey),
  })
)(generated);

const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

const { crv, kty, x, y } = Schema.decodeUnknownSync(
  Schema.Struct({
    crv: Schema.Literal("P-256"),
    kty: Schema.Literal("EC"),
    x: Schema.String,
    y: Schema.String,
  })
)(jwk);

const document = {
  authentication: [keyId],
  id: operator,
  keyAgreement: [],
  verificationMethod: [
    { controller: operator, id: keyId, publicKeyJwk: { crv, kty, x, y } },
  ],
};

execFileSync(
  esbuild,
  [
    "apps/mailbox/test/fixtures/cellwake-worker.ts",
    "--bundle",
    "--format=esm",
    "--platform=browser",
    "--conditions=workerd,worker,browser",
    "--external:cloudflare:workers",
    "--external:node:*",
    '--define:__BUNDLE_COMMIT__="fixture"',
    '--define:__BUNDLE_VERSION__="fixture"',
    `--outfile=${path.join(work, "worker.mjs")}`,
  ],
  { stdio: "inherit" }
);

const bindings = {
  AUTH_TOKENS: "AuthTokens",
  ISSUER: "FixtureIssuer",
  MAILBOX: "Mailbox",
};

await writeFile(
  path.join(work, "wrangler.json"),
  JSON.stringify({
    compatibility_date: "2026-10-04",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: {
      bindings: Object.entries(bindings).map(([name, class_name]) => ({
        class_name,
        name,
      })),
    },
    main: "worker.mjs",
    migrations: [
      { new_sqlite_classes: [...new Set(Object.values(bindings))], tag: "v1" },
    ],
    name: "cellwake-proof",
    no_bundle: true,
    vars: {
      DID_DOCUMENTS: "[]",
      NAME_STATE_VIEWS: "names,retired,snapshot",
      OPERATOR_DIDS: JSON.stringify([operator]),
      SERVICE_DID: service,
    },
  })
);

const socket = createServer();

socket.listen(0, "127.0.0.1");

await once(socket, "listening");

const address = socket.address();

const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
  address
);

const closed = once(socket, "close");

socket.close();

await closed;

const origin = `http://127.0.0.1:${port}`;

const child = spawn(
  celld,
  ["dev", work, "--port", String(port), "--logs", "--no-watch"],
  { env: { ...process.env, NO_COLOR: "1", RUST_LOG: "info" } }
);

let log = "";

const append = (chunk: Buffer) => {
  log += String(chunk);
};

child.stderr.on("data", append);

child.stdout.on("data", append);

const stopped = once(child, "exit");

const request = async (url: string, options?: RequestInit) => {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });

  assert.ok(
    response.ok,
    `${new URL(url).pathname}: HTTP ${response.status}: ${await response.clone().text()}`
  );

  return response;
};

const starts = () =>
  log
    .split("\n")
    .filter(
      (line) =>
        line.includes("cell_isolate_startup_timing") &&
        line.includes("scope=Mailbox:")
    );

const State = Schema.fromJsonString(
  Schema.Struct({
    deployment: Schema.Struct({
      cells: Schema.Record(Schema.String, Schema.Int),
    }),
  })
);

const members = (state: typeof State.Type) =>
  Object.keys(state.deployment.cells).filter((name) =>
    name.startsWith("Mailbox:")
  );

const Entry = Schema.Struct({
  name: Schema.String,
  status: Schema.optionalKey(Schema.String),
});

const Page = Schema.fromJsonString(
  Schema.Struct({
    cursor: Schema.optionalKey(Schema.String),
    names: Schema.optionalKey(Schema.Array(Entry)),
    retired: Schema.optionalKey(Schema.Array(Entry)),
  })
);

type Params = Record<string, string | number | boolean>;

const directory = async (variant: string, params: Params) => {
  const nsid = `sh.mschf.ratking.identity.${variant}`;
  const now = Math.floor(Date.now() / 1000);

  const token = await Effect.runPromise(
    serviceToken(
      {
        aud: `${service}#mailbox`,
        exp: now + 60,
        iat: now,
        iss: operator,
        jti: crypto.randomUUID(),
        lxm: nsid,
      },
      pair.privateKey,
      keyId
    )
  );

  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)])
  );

  const response = await request(`${origin}/xrpc/${nsid}?${query.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  return Schema.decodeSync(Page)(await response.text());
};

try {
  for (
    let attempt = 0;
    attempt < 250 && !log.includes(`ready  ${origin}`);
    attempt += 1
  ) {
    assert.ok(child.exitCode === null, "celld dev exited before readiness");
    await pause(100);
  }

  assert.ok(log.includes(`ready  ${origin}`), "celld dev did not report ready");

  const internal =
    /celld internal listening on (?<address>127\.0\.0\.1:\d+)/u.exec(log)
      ?.groups?.address;

  assert.ok(
    internal !== undefined,
    "celld dev did not report internal listener"
  );

  const state = async () => {
    const response = await request(`http://${internal}/state`);

    return Schema.decodeSync(State)(await response.text());
  };

  for (let start = 0; start < 6200; start += 100) {
    await request(`${origin}/fixture/fill?start=${start}`, { method: "POST" });
  }

  await request(`${origin}/fixture/document`, {
    body: JSON.stringify(document),
    method: "POST",
  });
  await directory("listNames", { limit: 1 });
  const before = await state();
  assert.deepEqual(members(before), []);
  assert.equal(starts().length, 0);

  const queries: readonly (readonly [string, Params, number])[] = [
    ["listNames", {}, 4650],
    ...["live", "idle", "retired", "unknown"].map(
      (status) => ["listNames", { match: "READER-", status }, 1550] as const
    ),
    ["listNames", { status: "live,idle,retired,unknown" }, 6200],
    ["listNames", { all: true }, 6200],
    ["listNames", { all: true, snapshot: true }, 6200],
    ["listRetired", {}, 1550],
    ["listRetired", { snapshot: true }, 1550],
  ];

  let pages = 0;

  for (const [variant, params, expected] of queries) {
    let cursor: string | undefined;
    const names = new Set<string>();

    do {
      const query = { ...params, limit: 100 };

      const page = await directory(
        variant,
        cursor === undefined ? query : { ...query, cursor }
      );

      const entries = page.names ?? page.retired;
      assert.ok(
        entries !== undefined,
        "directory page contained neither names nor retirements"
      );

      for (const { name } of entries) {
        assert.ok(!names.has(name), "duplicate directory row");
        names.add(name);
      }

      ({ cursor } = page);
      pages += 1;
    } while (cursor !== undefined);

    assert.equal(names.size, expected);
  }

  assert.deepEqual(members(await state()), []);
  assert.equal(starts().length, 0);

  const acquire = await request(
    `${origin}/fixture/acquire?expiresAt=${encodeURIComponent(new Date(Date.now() + 120_000).toISOString())}`,
    {
      method: "POST",
    }
  );

  const lease = Schema.decodeSync(
    Schema.fromJsonString(Schema.Struct({ generation: Schema.Int }))
  )(await acquire.text());

  assert.equal(lease.generation, 1);
  assert.equal(
    members(await state()).length,
    1,
    "/state must see the positive control"
  );

  for (let attempt = 0; attempt < 50 && starts().length === 0; attempt += 1) {
    await pause(20);
  }

  assert.equal(starts().length, 1, "journal must see the positive control");
  let observed;

  for (let attempt = 0; attempt < 50 && observed !== "live"; attempt += 1) {
    const page = await directory("listNames", { match: "reader-0001" });
    observed = page.names?.[0]?.status;

    if (observed !== "live") {
      await pause(50);
    }
  }

  assert.equal(observed, "live", "committed lease must reach the Issuer");
  console.log(
    JSON.stringify({
      mailboxStarts: 0,
      pages,
      positiveControl: 1,
      seedRows: 6200,
    })
  );
} catch (error) {
  console.error(log.slice(-12_000));
  throw error;
} finally {
  child.kill("SIGTERM");
  await stopped;
  await writeFile(path.join(work, "celld.log"), log);
  console.log(`Throwaway log: ${path.join(work, "celld.log")}`);
}
