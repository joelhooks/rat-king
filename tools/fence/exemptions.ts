// @effect-diagnostics nodeBuiltinImport:off -- Publication tooling hashes exact blob bytes at the owner-approved exemption boundary.
import { createHash } from "node:crypto";

import { Schema } from "effect";

import data from "./exemptions.json" with { type: "json" };

const Entry = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
  rules: Schema.Array(
    Schema.Literals(["email", "secret-name", "gitleaks:generic-api-key"])
  ),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});

export const exemptions = Schema.decodeUnknownSync(Schema.Array(Entry))(data);

export const blobHash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

export const isExempt = (path: string, sha256: string, rule: string) =>
  exemptions.some(
    (entry) =>
      entry.path === path &&
      entry.sha256 === sha256 &&
      entry.rules.some((approved) => approved === rule)
  );
