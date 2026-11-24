import { execFile } from "node:child_process";
import {
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

const unit = "rat-king-pds.service";

const marker = "/run/rat-king-pds-snapshot/resume";

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

const ctl = async (...args: string[]) =>
  await exec("/usr/bin/systemctl", [...args, unit]);

const activeState = async () => {
  const { stdout } = await ctl("show", "--property=ActiveState", "--value");

  return stdout.trim();
};

const checkRootControlled = async (directory: string): Promise<void> => {
  const entry = await lstat(directory);
  const mode = (entry.mode % 0o1000).toString(8).padStart(3, "0");

  if (
    !entry.isDirectory() ||
    entry.uid !== 0 ||
    /[2367]/u.test(mode.slice(1))
  ) {
    throw new Error(
      "Snapshot destination and its ancestors must be root-controlled real directories."
    );
  }

  if (directory !== "/") {
    await checkRootControlled(path.dirname(directory));
  }
};

const sqliteBackup = async (source: string, destination: string) => {
  const name = path.basename(destination);

  if (!/^[a-zA-Z0-9_-]+\.sqlite$/u.test(name)) {
    throw new Error("Unexpected SQLite database filename.");
  }

  await exec(
    "/usr/bin/sqlite3",
    ["-batch", "-bail", "-readonly", source, `.backup ${name}`],
    { cwd: path.dirname(destination) }
  );

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
    } else if (!/\.sqlite-(?:shm|wal|journal)$/u.test(name)) {
      await copyFile(from, to);
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

const resume = async () => {
  if (await exists(marker)) {
    await ctl("start");

    if ((await activeState()) !== "active") {
      throw new Error("PDS did not return to active state after its snapshot.");
    }

    await rm(marker);
  }
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

const scheduledSnapshot = async (source: string, root: string) => {
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

  await checkRootControlled(root);
  await checkRootControlled(path.dirname(source));

  const now = new Date();
  const destination = path.join(root, dateKey(now));

  if (await exists(destination)) {
    await assertSnapshot(destination);
    console.log("PDS_SNAPSHOT_ALREADY_COMPLETE");

    return;
  }

  if ((await activeState()) !== "active") {
    console.log("PDS_SNAPSHOT_SKIPPED_ORIGIN_NOT_ACTIVE");

    return;
  }

  const stage = await mkdtemp(path.join(root, ".partial-"));

  try {
    await writeFile(marker, "resume\n", { flag: "wx", mode: 0o600 });

    try {
      await ctl("stop");

      if ((await activeState()) !== "inactive") {
        throw new Error(
          "PDS did not quiesce; refusing to copy SQLite and blobs."
        );
      }

      await snapshotTree(source, stage);
    } finally {
      await resume();
    }

    await rename(stage, destination);
    await prune(root, now);
    console.log("PDS_SNAPSHOT_OK");
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
};

if (import.meta.main) {
  process.umask(0o077);
  const [mode, source, root] = process.argv.slice(2);

  if (mode === "recover") {
    await resume();
  } else if (
    mode === "snapshot" &&
    source !== undefined &&
    root !== undefined
  ) {
    await scheduledSnapshot(source, root);
  } else {
    throw new Error("Expected snapshot <source> <backup-root> or recover.");
  }
}
