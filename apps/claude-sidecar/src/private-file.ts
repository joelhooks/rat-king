/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop -- POSIX masks and root-to-leaf checks must run sequentially before opening a credential. */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Host-only credential file boundary.
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
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
    const descriptor = await open(
      parent,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
    );

    try {
      const metadata = await descriptor.stat();

      if (
        !metadata.isDirectory() ||
        (metadata.mode & 0o022) !== 0 ||
        (metadata.uid !== 0 && metadata.uid !== uid)
      ) {
        throw new Error("Credential directory must not be writable by others");
      }
    } finally {
      await descriptor.close();
    }
  }

  const descriptor = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );

  try {
    const metadata = await descriptor.stat();

    if (!isPrivateFile(metadata, uid)) {
      throw new Error(
        "Credential must be a nonempty owned private regular file"
      );
    }

    return await descriptor.readFile("utf-8");
  } finally {
    await descriptor.close();
  }
};

export const generateBearer = () => randomBytes(32).toString("hex");

export const requireBearer = (token: string) => {
  if (Buffer.byteLength(token, "utf-8") < 32) {
    throw new Error("Bearer token must have at least 32 bytes");
  }

  return token;
};
