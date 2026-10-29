// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise standalone Node scripts and exact filesystem modes.
/* oxlint-disable eslint/no-bitwise -- Tests assert POSIX mode masks and flip a ciphertext bit. */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Schema } from "effect";
import { afterEach, expect } from "vitest";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) {
    expect(spawnSync("gio", ["trash", dir]).status).toBe(0);
  }
});

const decodeDocument = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      verificationMethod: Schema.Array(
        Schema.Struct({
          publicKeyJwk: Schema.Record(Schema.String, Schema.Json),
        })
      ),
    })
  )
);

const decodeBlob = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ct: Schema.String,
      enc: Schema.String,
      kid: Schema.String,
      v: Schema.Literal(1),
    })
  )
);

const run = (dir: string, script: string, args: string[], input?: string) =>
  spawnSync(
    process.execPath,
    [path.resolve(`tools/grokbox/${script}.mjs`), ...args],
    {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, RATKING_SECRETS_DIR: path.join(dir, "secrets") },
      input,
    }
  );

const directory = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grokbox-kit-"));
  directories.push(dir);

  return dir;
};

const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,12}$/u));

it.prop(
  "shim add refuses replacement and unsafe names, leases exact bytes, and enforces private modes",
  [Name],
  ([name]) => {
    const dir = directory();
    expect(run(dir, "secrets", ["add", name], "private-value").status).toBe(0);
    expect(statSync(path.join(dir, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "secrets", name)).mode & 0o777).toBe(0o600);
    expect(run(dir, "secrets", ["add", name], "replacement").status).toBe(1);
    expect(
      run(dir, "secrets", ["lease", name, "--ttl", "1m", "--client-id", "test"])
        .stdout
    ).toBe("private-value");
    expect(
      JSON.parse(run(dir, "secrets", ["--no-update-check", "list"]).stdout)
    ).toEqual({ ok: true, result: { secrets: [{ name }] } });

    for (const bad of [
      "../escape",
      "/absolute",
      "",
      ".hidden",
      "a/b",
      "has space",
    ]) {
      expect(run(dir, "secrets", ["add", bad], "value").status).toBe(1);
      expect(run(dir, "secrets", ["lease", bad]).status).toBe(1);
    }

    chmodSync(path.join(dir, "secrets", name), 0o644);
    expect(run(dir, "secrets", ["lease", name]).status).toBe(1);
    expect(run(dir, "secrets", ["list"]).status).toBe(1);
  },
  { arbitrary: { runs: 3 } }
);

it("shim refuses file and directory symlinks", () => {
  const dir = directory();
  writeFileSync(path.join(dir, "target"), "not-a-key", { mode: 0o600 });
  symlinkSync(dir, path.join(dir, "secrets"));
  expect(run(dir, "secrets", ["list"]).status).toBe(1);
  const other = directory();
  expect(run(other, "secrets", ["list"]).status).toBe(0);
  symlinkSync(path.join(dir, "target"), path.join(other, "secrets", "linked"));
  expect(run(other, "secrets", ["lease", "linked"]).status).toBe(1);
  expect(run(other, "secrets", ["add", "linked"], "overwrite").status).toBe(1);
  expect(readFileSync(path.join(dir, "target"), "utf-8")).toBe("not-a-key");
});

it.prop(
  "mint prints only public keys; HPKE round-trips exact bytes from any cwd and refuses tampered, wrong-host and existing output paths",
  [Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60))],
  ([plain]) => {
    const dir = directory();

    const minted = run(dir, "mint-host", [
      "did:web:host.example.invalid",
      "host-key",
    ]);

    expect(minted.status).toBe(0);
    const document = decodeDocument(minted.stdout);
    expect(document.id).toBe("did:web:host.example.invalid");
    expect(document.verificationMethod).toHaveLength(2);

    for (const method of document.verificationMethod) {
      expect(method.publicKeyJwk).not.toHaveProperty("d");
    }

    const original = readFileSync(
      path.join(dir, "secrets", "host-key"),
      "utf-8"
    );

    expect(
      run(dir, "mint-host", ["did:web:host.example.invalid", "host-key"]).status
    ).toBe(1);
    expect(readFileSync(path.join(dir, "secrets", "host-key"), "utf-8")).toBe(
      original
    );
    const file = path.join(dir, "public.json");
    writeFileSync(file, minted.stdout);
    const sealed = run(dir, "seal", [file], plain);
    expect(sealed.status).toBe(0);
    expect(sealed.stdout).not.toContain("private-value");
    const out = path.join(dir, "opened");
    expect(
      run(dir, "open-sealed", [out, "host-key"], sealed.stdout).status
    ).toBe(0);
    expect(readFileSync(out)).toEqual(Buffer.from(plain));
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(
      run(dir, "open-sealed", [out, "host-key"], sealed.stdout).status
    ).toBe(1);
    expect(readFileSync(out)).toEqual(Buffer.from(plain));
    const blob = decodeBlob(sealed.stdout);
    const bytes = Buffer.from(blob.ct, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const tampered = path.join(dir, "tampered");
    expect(
      run(
        dir,
        "open-sealed",
        [tampered, "host-key"],
        JSON.stringify({ ...blob, ct: bytes.toString("base64url") })
      ).status
    ).toBe(1);
    expect(existsSync(tampered)).toBe(false);
    expect(
      run(dir, "mint-host", ["did:web:other.example.invalid", "other-key"])
        .status
    ).toBe(0);
    const wrong = path.join(dir, "wrong");
    expect(
      run(dir, "open-sealed", [wrong, "other-key"], sealed.stdout).status
    ).toBe(1);
    expect(existsSync(wrong)).toBe(false);
  },
  { arbitrary: { runs: 3 } }
);
