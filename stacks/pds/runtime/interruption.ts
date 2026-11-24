import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { online } from "./control.ts";
import { localIdentity, textField, xrpc } from "./local.ts";
import { publishSnapshot, snapshotTree } from "./snapshot.ts";

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
  const backups = path.dirname(snapshot);
  const identity = localIdentity();
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  await mkdir(creds, { mode: 0o700 });
  await mkdir(backups, { mode: 0o700 });
  await chmod(backups, 0o2750);
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
      const [socket, source, destination] = process.argv.slice(1);
      await publishSnapshot(socket, destination, async (partial) => {
        await copyFile(source, join(partial, 'blob'));
        process.send('copied-one-file');
        await once(process, 'disconnect');
      });
    `,
        socket,
        path.join(data, "blobs", "snapshot-fixture"),
        snapshot,
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
    const partials = await readdir(backups);
    assert.equal(partials.length, 1);
    assert.match(partials[0] ?? "", /^\.partial-/u);
    const stage = await stat(path.join(backups, partials[0] ?? ""));
    assert.equal(stage.mode % 0o1000, 0o700);

    const umask = process.umask(0o027);

    try {
      await publishSnapshot(socket, snapshot, async (generation) => {
        await snapshotTree(data, generation, true);
      });
    } finally {
      process.umask(umask);
    }

    const generation = await stat(snapshot);
    const blob = await stat(path.join(snapshot, "blobs", "snapshot-fixture"));
    assert.equal(generation.mode % 0o1_0000, 0o2750);
    assert.equal(blob.mode % 0o1000, 0o640);
    assert.equal(textField(await xrpc(origin, "_health"), "version"), "0.5.65");
    console.log("PDS_SNAPSHOT_SIGKILL_RECOVERY_OK");
  } finally {
    service.kill("SIGTERM");
    assert.deepEqual(await serviceExit, [0, null]);
  }
};
