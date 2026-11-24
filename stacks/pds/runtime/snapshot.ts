import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

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

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

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
  groupReadable: boolean,
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
      await mkdir(to, { mode: groupReadable ? 0o750 : 0o700 });
      await copyTree(from, to, groupReadable, false);
    } else if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Snapshot refused a link or non-regular state entry.");
    } else if (name.endsWith(".sqlite")) {
      await sqliteBackup(from, to);
    } else if (/\.sqlite-(?:shm|wal|journal)$/u.test(name)) {
      continue;
    } else {
      await copyFile(from, to);
    }

    if (groupReadable && entry.isFile()) {
      await chmod(to, 0o640);
    }
  }
};

export const snapshotTree = async (
  source: string,
  destination: string,
  groupReadable = false
) => {
  const directory = await lstat(source);
  const accounts = await lstat(path.join(source, "account.sqlite"));

  if (!directory.isDirectory() || !accounts.isFile()) {
    throw new Error("Snapshot requires an initialized PDS data directory.");
  }

  await copyTree(source, destination, groupReadable);
  await writeFile(path.join(destination, manifest), version, {
    flag: "wx",
    mode: groupReadable ? 0o640 : 0o600,
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
    if (datePattern.test(name) && name < keepFrom) {
      const old = path.join(root, name);
      const receipt = path.join(old, manifest);
      const directory = await lstat(old);

      if (!directory.isDirectory() || !(await exists(receipt))) {
        continue;
      }

      const entry = await lstat(receipt);

      if (entry.isFile() && (await readFile(receipt, "utf-8")) === version) {
        await rm(old, { recursive: true });
      }
    }
  }
};

/* oxlint-enable no-await-in-loop */

export const publishSnapshot = async (
  location: string,
  destination: string,
  copy: (generation: string) => Promise<void>
) => {
  const stage = await mkdtemp(
    path.join(path.dirname(destination), ".partial-")
  );

  try {
    const generation = path.join(stage, "generation");
    await mkdir(generation, { mode: 0o750 });
    await withSnapshotLease(location, async () => {
      await copy(generation);
    });
    await rename(generation, destination);
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
};

const scheduledSnapshot = async (
  location: string,
  source: string,
  root: string
) => {
  if (
    path.resolve(root) !== root ||
    path.resolve(source) !== source ||
    root === source ||
    root.startsWith(`${source}/`) ||
    source.startsWith(`${root}/`)
  ) {
    throw new Error(
      "Snapshot source and destination must be distinct absolute trees."
    );
  }

  await checkRootControlled(path.dirname(root));
  await checkRootControlled(path.dirname(source));

  const target = await lstat(root);

  if (
    !target.isDirectory() ||
    target.uid !== process.getuid?.() ||
    target.mode % 0o1_0000 !== 0o2750
  ) {
    throw new Error(
      "Backup root must be owned by the snapshot user and have mode 2750."
    );
  }

  const now = new Date();
  const destination = path.join(root, dateKey(now));

  if (await exists(destination)) {
    await assertSnapshot(destination);
    console.log("PDS_SNAPSHOT_ALREADY_COMPLETE");

    return;
  }

  await publishSnapshot(location, destination, async (generation) => {
    await snapshotTree(source, generation, true);
  });
  await prune(root, now);
  console.log("PDS_SNAPSHOT_OK");
};

if (import.meta.main) {
  process.umask(0o027);
  const [mode, location, source, root] = process.argv.slice(2);

  if (mode === "recover" && location !== undefined) {
    await recover(location);
  } else if (
    mode === "snapshot" &&
    location !== undefined &&
    source !== undefined &&
    root !== undefined
  ) {
    await scheduledSnapshot(location, source, root);
  } else {
    throw new Error(
      "Expected snapshot <control> <source> <backup-root> or recover <control>."
    );
  }
}
