import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { encryptArchive } from "./archive.ts";
import {
  accepted,
  command,
  copied,
  pause,
  quiesced,
  recover,
  withControl,
} from "./control.ts";

const exec = async (
  binary: string,
  args: string[],
  options?: { readonly cwd: string }
) => {
  const result = Promise.withResolvers<{ readonly stdout: string }>();

  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Bridge Node's execFile callback into the awaited result.
  execFile(binary, args, { ...options, encoding: "utf-8" }, (error, stdout) => {
    if (error === null) {
      result.resolve({ stdout });
    } else {
      result.reject(error);
    }
  });

  return await result.promise;
};

const manifest = ".rat-king-pds-snapshot";

const version = "rat-king-pds-snapshot-v1\n";

const archivePattern = /^\d{4}-\d{2}-\d{2}\.tar\.age$/u;

const hourMs = 60 * 60 * 1000;

const dateFormat = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/Los_Angeles",
  year: "numeric",
});

const dateKey = (date: Date) => dateFormat.format(date);

const checkRootControlled = async (directory: string): Promise<void> => {
  const entry = await lstat(directory);
  const mode = (entry.mode % 0o1000).toString(8).padStart(3, "0");

  if (
    !entry.isDirectory() ||
    entry.uid !== 0 ||
    /[2367]/u.test(mode.slice(1))
  ) {
    throw new Error(
      "Snapshot tree parents must be root-controlled real directories."
    );
  }

  if (directory !== "/") {
    await checkRootControlled(path.dirname(directory));
  }
};

const exists = async (location: string) => {
  try {
    await lstat(location);

    return true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }

    return false;
  }
};

const copyJournal = async (
  source: string,
  destination: string,
  suffix: string
) => {
  const journal = source + suffix;

  if (await exists(journal)) {
    const entry = await lstat(journal);

    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error(
        "Snapshot refused a linked or non-regular SQLite journal."
      );
    }

    await copyFile(journal, destination + suffix);
  }
};

const sqliteBackup = async (source: string, destination: string) => {
  const name = path.basename(destination);

  if (!/^[a-zA-Z0-9_-]+\.sqlite$/u.test(name)) {
    throw new Error("Unexpected SQLite database filename.");
  }

  const scratch = await mkdtemp(
    path.join(path.dirname(destination), ".sqlite-")
  );

  const local = path.join(scratch, name);

  try {
    await copyFile(source, local);
    await chmod(local, 0o600);
    await Promise.all([
      copyJournal(source, local, "-wal"),
      copyJournal(source, local, "-journal"),
    ]);
    await exec(
      "/usr/bin/sqlite3",
      ["-batch", "-bail", local, `.backup ${name}`],
      { cwd: path.dirname(destination) }
    );
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }

  const { stdout } = await exec("/usr/bin/sqlite3", [
    "-batch",
    "-bail",
    "-readonly",
    destination,
    "PRAGMA quick_check",
  ]);

  if (stdout.trim() !== "ok") {
    throw new Error("Snapshot SQLite quick_check failed.");
  }
};

/* oxlint-disable no-await-in-loop -- Serialize SQLite copies and retention to bound I/O while the origin is quiesced. */
const copyTree = async (
  source: string,
  destination: string,
  root = true
): Promise<void> => {
  for (const name of await readdir(source)) {
    if (root && name === manifest) {
      continue;
    }

    const from = path.join(source, name);
    const to = path.join(destination, name);
    const entry = await lstat(from);

    if (entry.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      await copyTree(from, to, false);
    } else if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Snapshot refused a link or non-regular state entry.");
    } else if (name.endsWith(".sqlite")) {
      await sqliteBackup(from, to);
    } else if (/\.sqlite-(?:shm|wal|journal)$/u.test(name)) {
      continue;
    } else {
      await copyFile(from, to);
    }

    if (entry.isFile()) {
      await chmod(to, 0o600);
    }
  }
};

export const snapshotTree = async (source: string, destination: string) => {
  const directory = await lstat(source);
  const accounts = await lstat(path.join(source, "account.sqlite"));

  if (!directory.isDirectory() || !accounts.isFile()) {
    throw new Error("Snapshot requires an initialized PDS data directory.");
  }

  await copyTree(source, destination);
  await writeFile(path.join(destination, manifest), version, {
    flag: "wx",
    mode: 0o600,
  });
};

export const assertSnapshot = async (snapshot: string) => {
  const receipt = path.join(snapshot, manifest);
  const directory = await lstat(snapshot);
  const entry = await lstat(receipt);

  if (
    !directory.isDirectory() ||
    !entry.isFile() ||
    (await readFile(receipt, "utf-8")) !== version
  ) {
    throw new Error("Not a completed PDS snapshot.");
  }
};

export const withSnapshotLease = async (
  location: string,
  copy: () => Promise<void>
) => {
  await withControl(location, async (socket) => {
    socket.write(pause);

    if ((await command(socket)) !== quiesced) {
      throw new Error("PDS did not quiesce; refusing to snapshot.");
    }

    await copy();

    socket.write(copied);

    if ((await command(socket)) !== accepted) {
      throw new Error("Lost PDS quiesce lease during the snapshot.");
    }
  });

  await recover(location);
};

const prune = async (root: string, now: Date) => {
  const days = new Date(`${dateKey(now)}T12:00:00Z`);
  days.setUTCDate(days.getUTCDate() - 6);
  const keepFrom = days.toISOString().slice(0, 10);

  for (const name of await readdir(root)) {
    if (archivePattern.test(name) && name.slice(0, 10) < keepFrom) {
      const old = path.join(root, name);
      const archive = await lstat(old);

      if (archive.isFile()) {
        await rm(old);
      }
    }
  }
};

/* oxlint-enable no-await-in-loop */

export const publishSnapshot = async ({
  age,
  copy,
  destination,
  location,
  privateRoot,
  recipient,
}: {
  readonly age: string;
  readonly copy: (generation: string) => Promise<void>;
  readonly destination: string;
  readonly location: string;
  readonly privateRoot: string;
  readonly recipient: string;
}) => {
  const generation = await mkdtemp(path.join(privateRoot, ".partial-"));

  try {
    await withSnapshotLease(location, async () => {
      await copy(generation);
    });
    await assertSnapshot(generation);

    const stage = await mkdtemp(
      path.join(path.dirname(destination), ".partial-")
    );

    try {
      const encrypted = path.join(stage, "archive.age");
      await encryptArchive({
        age,
        destination: encrypted,
        generation,
        recipient,
      });
      await chmod(encrypted, 0o640);
      await link(encrypted, destination);
      await using exports = await open(path.dirname(destination), "r");
      await exports.sync();
    } finally {
      await rm(stage, { force: true, recursive: true });
    }
  } finally {
    await rm(generation, { force: true, recursive: true });
  }
};

const archiveEntry = async (file: string) => {
  const entry = await lstat(file);

  if (!entry.isFile() || entry.size === 0 || entry.mode % 0o1000 !== 0o640) {
    throw new Error(
      "Expected a nonempty regular snapshot archive at mode 0640."
    );
  }

  return entry;
};

export const snapshotAge = async (
  root: string,
  maxHours: number,
  now = Date.now()
) => {
  if (!Number.isSafeInteger(maxHours) || maxHours < 1 || maxHours > 168) {
    throw new Error("Expected a maximum snapshot age from 1 to 168 hours.");
  }

  const names = await readdir(root);

  const newest = names
    .filter((name) => archivePattern.test(name))
    .toSorted()
    .at(-1);

  if (newest === undefined) {
    throw new Error("No completed PDS snapshot archive.");
  }

  const entry = await archiveEntry(path.join(root, newest));
  const elapsed = now - entry.mtimeMs;

  if (elapsed < 0 || elapsed > maxHours * hourMs) {
    throw new Error(
      "Newest PDS snapshot archive is stale or timestamped in the future."
    );
  }

  return Math.floor(elapsed / 1000);
};

const checkSnapshotRoot = async (
  root: string,
  mode: number,
  privateRoot: boolean
) => {
  await checkRootControlled(path.dirname(root));
  const target = await lstat(root);

  if (
    !target.isDirectory() ||
    target.uid !== process.getuid?.() ||
    target.mode % 0o1_0000 !== mode ||
    (privateRoot && target.gid !== process.getgid?.())
  ) {
    throw new Error("Snapshot roots have incorrect ownership or permissions.");
  }
};

const scheduledSnapshot = async (
  location: string,
  source: string,
  privateRoot: string,
  exports: string,
  recipient: string
) => {
  const paths = [source, privateRoot, exports];

  if (
    paths.some(
      (dir) =>
        dir === "/" ||
        path.resolve(dir) !== dir ||
        paths.filter((other) => other === dir || other.startsWith(`${dir}/`))
          .length !== 1
    )
  ) {
    throw new Error(
      "Snapshot source, scratch and export paths must be distinct absolute trees."
    );
  }

  await checkRootControlled(path.dirname(source));
  await checkSnapshotRoot(privateRoot, 0o700, true);
  await checkSnapshotRoot(exports, 0o2750, false);
  const now = new Date();
  const destination = path.join(exports, `${dateKey(now)}.tar.age`);

  if (await exists(destination)) {
    await archiveEntry(destination);
    console.log("PDS_SNAPSHOT_ALREADY_COMPLETE");

    return;
  }

  await publishSnapshot({
    age: "/usr/bin/age",
    copy: async (generation) => {
      await snapshotTree(source, generation);
    },
    destination,
    location,
    privateRoot,
    recipient,
  });
  await prune(exports, now);
  console.log("PDS_SNAPSHOT_OK");
};

if (import.meta.main) {
  process.umask(0o077);

  const [mode, location, source, privateRoot, exports, recipient] =
    process.argv.slice(2);

  if (mode === "recover" && location !== undefined) {
    await recover(location);
  } else if (
    mode === "snapshot-age" &&
    location !== undefined &&
    source !== undefined
  ) {
    const age = await snapshotAge(location, Number(source));
    console.log(`PDS_SNAPSHOT_FRESH ageSeconds=${age}`);
  } else if (
    mode === "snapshot" &&
    location !== undefined &&
    source !== undefined &&
    privateRoot !== undefined &&
    exports !== undefined &&
    recipient !== undefined
  ) {
    await scheduledSnapshot(location, source, privateRoot, exports, recipient);
  } else {
    throw new Error(
      "Expected snapshot <control> <source> <scratch> <exports> <recipient>, recover <control>, or snapshot-age <exports> <max-hours>."
    );
  }
}
