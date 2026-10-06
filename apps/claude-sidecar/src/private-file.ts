/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop -- POSIX masks and root-to-leaf checks must run sequentially before opening a credential. */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off globalConsole:off -- Host-only credential file boundary.
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export const runningUid = () => {
  if (process.getuid === undefined) {
    throw new Error("Credential checks require a POSIX uid");
  }

  return process.getuid();
};

export const isPrivateFile = (metadata: Stats, uid = runningUid()) =>
  metadata.isFile() &&
  metadata.uid === uid &&
  (metadata.mode & 0o7177) === 0 &&
  metadata.size > 0;

export class CredentialRefusalError extends Error {
  readonly check:
    | "owner"
    | "mode"
    | "symlink"
    | "file_type"
    | "size"
    | "length"
    | "read";
  readonly component: string;

  constructor(
    check:
      | "owner"
      | "mode"
      | "symlink"
      | "file_type"
      | "size"
      | "length"
      | "read",
    component: string
  ) {
    super(`Credential refused: ${check} at ${component}`);
    this.name = "CredentialRefusalError";
    this.check = check;
    this.component = component;
  }
}

export const validatePrivateFile = (
  metadata: Stats,
  component: string,
  directory = false,
  uid = runningUid()
) => {
  if (metadata.isSymbolicLink()) {
    throw new CredentialRefusalError("symlink", component);
  }

  if (directory ? !metadata.isDirectory() : !metadata.isFile()) {
    throw new CredentialRefusalError("file_type", component);
  }

  if (metadata.uid !== uid && !(directory && metadata.uid === 0)) {
    throw new CredentialRefusalError("owner", component);
  }

  if ((metadata.mode & (directory ? 0o022 : 0o7177)) !== 0) {
    throw new CredentialRefusalError("mode", component);
  }

  if (!directory && metadata.size <= 0) {
    throw new CredentialRefusalError("size", component);
  }
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Catch boundary classifies unknown failures without exposing raw detail.
export const logCredentialRefusal = (error: unknown, file: string) => {
  const refusal =
    error instanceof CredentialRefusalError
      ? error
      : new CredentialRefusalError("read", path.resolve(file));

  console.error(
    JSON.stringify({
      check: refusal.check,
      component: refusal.component,
      event: "sidecar_credential_refusal",
    })
  );
};

export const readPrivateFile = async (file: string) => {
  const uid = runningUid();
  const absolute = path.resolve(file);
  const directories: string[] = [];
  let directory = path.dirname(absolute);

  while (true) {
    directories.unshift(directory);

    const parent = path.dirname(directory);

    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  for (const parent of directories) {
    validatePrivateFile(await lstat(parent), parent, true, uid);

    const descriptor = await open(
      parent,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
    );

    try {
      const metadata = await descriptor.stat();

      validatePrivateFile(metadata, parent, true, uid);
    } finally {
      await descriptor.close();
    }
  }

  validatePrivateFile(await lstat(absolute), absolute, false, uid);

  const descriptor = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );

  try {
    const metadata = await descriptor.stat();

    validatePrivateFile(metadata, absolute, false, uid);

    return await descriptor.readFile("utf-8");
  } finally {
    await descriptor.close();
  }
};

export const generateBearer = () => randomBytes(32).toString("hex");

export const requireBearer = (token: string, file = "bearer") => {
  if (Buffer.byteLength(token, "utf-8") < 32) {
    throw new CredentialRefusalError("length", path.resolve(file));
  }

  return token;
};
