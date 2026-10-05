// @effect-diagnostics nodeBuiltinImport:off -- Owned offline Python custody fixtures.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { afterEach, expect } from "vitest";

import {
  sidecarUnit,
  validateRuntimeFiles,
} from "../src/agent-runtime-files.ts";
import type { RuntimeFilesProps } from "../src/agent-runtime-files.ts";
import { runtimeScript } from "../src/agent-runtime-script.ts";
import { bindingConfigurationScript } from "../src/deployment.ts";
import { sliceUnit } from "../src/service-units.ts";
import { renderUnit } from "../src/systemd.ts";

const owned: string[] = [];

const did = "did:web:agent.example.invalid";

const BindingValues = Schema.Record(Schema.String, Schema.String);

const decodeBindings = Schema.decodeSync(Schema.fromJsonString(BindingValues));

const decodeConfig = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ vars: BindingValues }))
);

const dummyKey = "fixture-only-not-a-real-key";

const fixture = (): RuntimeFilesProps => {
  const home = realpathSync(
    mkdtempSync(path.join(tmpdir(), "rat-king-custody-test-"))
  );

  owned.push(home);
  const agents = path.join(home, ".config/rat-king/agents");
  mkdirSync(agents, { mode: 0o700, recursive: true });
  mkdirSync(path.join(home, ".local/share/rat-king"), {
    mode: 0o700,
    recursive: true,
  });
  writeFileSync(
    path.join(agents, "agent.jwk"),
    JSON.stringify({ agreement: {}, did, signing: {} }),
    { mode: 0o600 }
  );

  return {
    agent: "agent",
    did,
    gatewayUrl: "",
    home,
    mode: "faux",
    ready: "fixture",
    secretName: "",
    sidecar: false,
    sidecarBundle: "",
  };
};

afterEach(() => {
  for (const home of owned.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

const execute = (props: RuntimeFilesProps, action = "apply", prefix = "") =>
  spawnSync(
    "python3",
    ["-c", prefix + runtimeScript, action, JSON.stringify(props)],
    { encoding: "utf-8" }
  );

const remoteStubs = String.raw`
import hashlib, io, json, subprocess, urllib.request
binary = b'#!/bin/sh\nprintf "2.1.285 (Claude Code)\\n"\n'
checksum = hashlib.sha256(binary).hexdigest()
def fetch(url, timeout):
    if url.endswith('manifest.json'):
        return io.BytesIO(json.dumps({'platforms': {'linux-x64': {'checksum': checksum}}}).encode())
    if url.endswith('linux-x64/claude'):
        return io.BytesIO(binary)
    raise ValueError('Network refused by fixture')
urllib.request.urlopen = fetch
original_run = subprocess.run
def run(argv, **kw):
    if argv[0] == 'secrets':
        assert argv == ['secrets', '--no-update-check', 'lease', 'fixture-key', '--ttl', '1h', '--client-id', 'rat-king-s6']
        return subprocess.CompletedProcess(argv, 0, stdout='fixture-only-not-a-real-key\n')
    return original_run(argv, **kw)
subprocess.run = run
`;

it("faux custody contains only the identity and no gateway origin", () => {
  const props = fixture();
  expect(execute(props).status).toBe(0);
  expect(execute(props, "observe").stdout.trim()).toBe("ready");

  const bindings = decodeBindings(
    readFileSync(
      path.join(props.home, ".config/rat-king/agent-runtime/bindings"),
      "utf-8"
    )
  );

  expect(Object.keys(bindings)).toEqual(["AGENT_IDENTITIES_CREDENTIAL"]);
  expect(bindings.AGENT_IDENTITIES_CREDENTIAL).toContain(did);
});

it("remote lease and checked sidecar installation are silent, isolated and idempotent", () => {
  const props = {
    ...fixture(),
    gatewayUrl: "http://gateway.example.invalid/v1",
    mode: "gateway",
    secretName: "fixture-key",
    sidecar: true,
    sidecarBundle: "fixture",
  } satisfies RuntimeFilesProps;

  const first = execute(props, "apply", remoteStubs);
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout.trim()).toBe("ready");
  expect(first.stdout + first.stderr).not.toContain(dummyKey);
  const root = path.join(props.home, ".config/rat-king/agent-runtime");

  const bindings = decodeBindings(
    readFileSync(path.join(root, "bindings"), "utf-8")
  );

  expect(bindings.MODEL_GATEWAY_CREDENTIAL).toBe(dummyKey);
  expect(bindings.CLAUDE_SIDECAR_CREDENTIAL).toMatch(/^[a-f0-9]{64}$/u);
  const second = execute(props, "apply", remoteStubs);
  expect(second.status, second.stderr).toBe(0);
  expect(
    decodeBindings(readFileSync(path.join(root, "bindings"), "utf-8"))
  ).toEqual(bindings);

  const binary = path.join(
    props.home,
    ".local/share/rat-king/claude-code/2.1.285/claude"
  );

  writeFileSync(binary, "changed installation");
  expect(execute(props, "apply", remoteStubs).status).toBe(1);
  expect(readFileSync(binary, "utf-8")).toBe("changed installation");
});

it("custody refuses symlink escape before writing", () => {
  const props = fixture();
  symlinkSync(
    tmpdir(),
    path.join(props.home, ".config/rat-king/agent-runtime")
  );
  const result = execute(props);
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe("Runtime custody operation refused");
});

it("private config generation merges bindings on target without returning them", () => {
  const props = fixture();
  expect(execute(props).status).toBe(0);
  const directory = path.join(props.home, ".config/rat-king/deployment");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(
    path.join(directory, "wrangler.public.json"),
    JSON.stringify({ vars: { AGENT_MODEL: "faux" } }),
    { mode: 0o600 }
  );

  const binding = path.join(
    props.home,
    ".config/rat-king/agent-runtime/bindings"
  );

  const result = spawnSync(
    "python3",
    ["-c", bindingConfigurationScript, directory, binding],
    { encoding: "utf-8" }
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(
    decodeConfig(readFileSync(path.join(directory, "wrangler.json"), "utf-8"))
      .vars.AGENT_IDENTITIES_CREDENTIAL
  ).toContain(did);
  chmodSync(binding, 0o644);
  expect(
    spawnSync("python3", ["-c", bindingConfigurationScript, directory, binding])
      .status
  ).toBe(1);
});

it("renders the approved unit and configurable slice cap, with unquoted EnvironmentFile", () => {
  const unit = renderUnit(sidecarUnit("/home/example", "ready"));
  expect(unit).toContain(
    "EnvironmentFile=/home/example/.local/share/rat-king/claude-sidecar/service.env\n"
  );

  for (const line of [
    "ExecStart=/usr/local/bin/node",
    "MemoryMax=1536M",
    "CPUQuota=100%",
    "KillMode=control-group",
    "NoNewPrivileges=true",
    "LimitCORE=0",
    "UMask=0077",
  ]) {
    expect(unit).toContain(line);
  }

  const slice = renderUnit(sliceUnit("/home/example", "5632M"));
  expect(slice).toContain("MemoryMax=5632M");
  expect(slice).toContain("CPUQuota=300%");
});

it.effect("faux runtime declarations refuse a gateway endpoint", () =>
  Effect.gen(function* refuseFauxOrigin() {
    const props = {
      ...fixture(),
      gatewayUrl: "http://gateway.example.invalid/v1",
    };

    const result = yield* Effect.result(validateRuntimeFiles(props));
    expect(result._tag).toBe("Failure");
  })
);
