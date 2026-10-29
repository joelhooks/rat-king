// @effect-diagnostics nodeBuiltinImport:off -- Standalone bootstrap filesystem boundary; keys never enter Effect logs.
/* oxlint-disable eslint/no-bitwise -- POSIX open flags and permission masks are bitfields. */
import {
  constants,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

const SecretName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u)
);

export const validName = Schema.is(SecretName);

const checkedName = Schema.decodeUnknownSync(SecretName);

export const secretDirectory = () => {
  const dir =
    process.env.RATKING_SECRETS_DIR ??
    path.join(homedir(), ".local/share/rat-king/secrets");

  mkdirSync(dir, { mode: 0o700, recursive: true });
  const stat = lstatSync(dir);

  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  ) {
    throw new Error("secret directory must be an owned directory, not a link");
  }

  const fd = openSync(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );

  try {
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }

  return dir;
};

export const addSecret = (name: string, value: string) => {
  const file = path.join(secretDirectory(), checkedName(name));

  if (value.length === 0) {
    throw new Error("add needs the value on stdin");
  }

  const fd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );

  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
};

const privateFile = (dir: string, name: string) => {
  const stat = lstatSync(path.join(dir, checkedName(name)));

  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error("secret must be an owned regular file with mode 0600");
  }
};

export const leaseSecret = (name: string) => {
  const dir = secretDirectory();
  privateFile(dir, checkedName(name));

  const fd = openSync(
    path.join(dir, name),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );

  try {
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
};

export const runSecrets = (argv: readonly string[]) => {
  const args = argv.filter((arg) => arg !== "--no-update-check");
  const [command, rawName] = args;
  const dir = secretDirectory();

  if (command === "list" && args.length === 1) {
    const secrets = readdirSync(dir)
      .filter(validName)
      .map((entry) => {
        privateFile(dir, entry);

        return { name: entry };
      });

    process.stdout.write(JSON.stringify({ ok: true, result: { secrets } }));
  } else if (command === "add" && args.length === 2) {
    const name = checkedName(rawName);
    addSecret(name, readFileSync(0, "utf-8"));
    process.stdout.write(JSON.stringify({ ok: true, result: { name } }));
  } else if (command === "lease") {
    const name = checkedName(rawName);
    const flags = args.slice(2);

    if (
      flags.length % 2 !== 0 ||
      flags.some(
        (arg, i) => i % 2 === 0 && arg !== "--ttl" && arg !== "--client-id"
      )
    ) {
      throw new Error("unsupported lease options");
    }

    process.stdout.write(leaseSecret(name));
  } else {
    throw new Error("usage: secrets list | add <name> | lease <name>");
  }
};
