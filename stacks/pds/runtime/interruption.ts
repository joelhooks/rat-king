import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { online } from "./control.ts";
import { localIdentity, textField, xrpc } from "./local.ts";
import { publishSnapshot, snapshotAge, snapshotTree } from "./snapshot.ts";

const reservePort = async () => {
  await using probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const bound = probe.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A local TCP bind returns an address object.
  assert.ok(bound !== null && typeof bound !== "string");

  return bound.port;
};

const runtime = (script: string) => path.join(import.meta.dirname, script);

export const proveInterruptedSnapshot = async ({
  commit,
  data,
  hostname,
  root,
  snapshot,
}: {
  readonly commit: string;
  readonly data: string;
  readonly hostname: string;
  readonly root: string;
  readonly snapshot: string;
}) => {
  const creds = path.join(root, "creds");
  const socket = path.join(root, "control.sock");
  const backups = path.join(root, "backups");
  const privateRoot = path.join(root, "private");
  const destination = path.join(backups, "2026-01-01.tar.age");
  const ageDir = process.env.PDS_PROOF_AGE_DIR ?? "/usr/bin";
  const age = path.join(ageDir, "age");
  const keygen = path.join(ageDir, "age-keygen");
  const key = path.join(root, "identity");
  const identity = localIdentity();
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  await mkdir(creds, { mode: 0o700 });
  await mkdir(backups, { mode: 0o700 });
  await chmod(backups, 0o2750);
  await mkdir(privateRoot, { mode: 0o700 });
  execFileSync(keygen, ["-o", key], { stdio: "pipe" });

  const recipient = execFileSync(keygen, ["-y", key], {
    encoding: "utf-8",
  }).trim();

  await Promise.all([
    writeFile(path.join(creds, "admin"), identity.secrets.admin),
    writeFile(path.join(creds, "jwt"), identity.secrets.jwt),
    writeFile(path.join(creds, "plc"), identity.secrets.rotation),
  ]);

  const service = spawn(
    process.execPath,
    [
      runtime("supervisor.ts"),
      socket,
      hostname,
      String(port),
      data,
      commit,
      identity.rotationPublicKey,
    ],
    {
      env: { ...process.env, CREDENTIALS_DIRECTORY: creds },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }
  );

  const serviceExit = once(service, "exit");

  try {
    const signal = AbortSignal.timeout(15_000);

    const first: readonly unknown[] = await once(service, "message", {
      signal,
    });

    assert.equal(first[0], online);

    const worker = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { once } from 'node:events';
      import { copyFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { publishSnapshot } from ${JSON.stringify(new URL("snapshot.ts", import.meta.url).href)};
      const [location, source, destination, privateRoot, age, recipient] = process.argv.slice(1);
      await publishSnapshot({ age, destination, location, privateRoot, recipient, copy: async (partial) => {
        await copyFile(source, join(partial, 'blob'));
        process.send('copied-one-file');
        await once(process, 'disconnect');
      } });
    `,
        socket,
        path.join(data, "blobs", "snapshot-fixture"),
        destination,
        privateRoot,
        age,
        recipient,
      ],
      { stdio: ["ignore", "inherit", "inherit", "ipc"] }
    );

    const workerExit = once(worker, "exit");

    try {
      const copied: readonly unknown[] = await once(worker, "message", {
        signal,
      });

      assert.equal(copied[0], "copied-one-file");
      await assert.rejects(
        fetch(`${origin}/xrpc/_health`, { signal }),
        /fetch failed/u
      );
    } finally {
      worker.kill("SIGKILL");
      assert.deepEqual(await workerExit, [null, "SIGKILL"]);
    }

    const postStop = spawn(
      process.execPath,
      [runtime("snapshot.ts"), "recover", socket],
      { signal, stdio: "inherit" }
    );

    assert.deepEqual(await once(postStop, "exit"), [0, null]);
    assert.equal(textField(await xrpc(origin, "_health"), "version"), "0.5.65");
    assert.deepEqual(await readdir(backups), []);
    const ageCommand = [runtime("snapshot.ts"), "snapshot-age", backups, "26"];
    assert.equal(spawnSync(process.execPath, ageCommand).status, 1);
    const partials = await readdir(privateRoot);
    assert.equal(partials.length, 1);
    assert.match(partials[0] ?? "", /^\.partial-/u);
    const stage = await stat(path.join(privateRoot, partials[0] ?? ""));
    assert.equal(stage.mode % 0o1000, 0o700);

    const publish = async (binary: string) => {
      await publishSnapshot({
        age: binary,
        copy: async (generation) => {
          await snapshotTree(data, generation);
        },
        destination,
        location: socket,
        privateRoot,
        recipient,
      });
    };

    await assert.rejects(publish("/usr/bin/false"));
    assert.deepEqual(await readdir(backups), []);
    await publish(age);
    assert.deepEqual(await readdir(backups), [path.basename(destination)]);
    const archive = await stat(destination);
    const exportRoot = await stat(backups);
    assert.equal(archive.mode % 0o1000, 0o640);
    assert.equal(archive.gid, exportRoot.gid);
    assert.match(
      execFileSync(process.execPath, ageCommand, { encoding: "utf-8" }),
      /^PDS_SNAPSHOT_FRESH/u
    );
    await assert.rejects(
      snapshotAge(backups, 26, Date.now() + 27 * 60 * 60 * 1000),
      /stale/u
    );

    const tar = path.join(root, "decrypted.tar");
    await mkdir(snapshot, { mode: 0o700 });
    execFileSync(age, ["-d", "-i", key, "-o", tar, destination]);
    execFileSync("/usr/bin/tar", [
      "-xf",
      tar,
      "-C",
      snapshot,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    console.log("PDS_SNAPSHOT_AGE_DECRYPT_OK");
    assert.equal(textField(await xrpc(origin, "_health"), "version"), "0.5.65");
    console.log("PDS_SNAPSHOT_SIGKILL_RECOVERY_OK");
  } finally {
    service.kill("SIGTERM");
    assert.deepEqual(await serviceExit, [0, null]);
  }
};
