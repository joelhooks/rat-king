import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getLexicon,
  localIdentity,
  textField,
  withPds,
  xrpc,
} from "./local.ts";
import { assertSnapshot, snapshotTree } from "./snapshot.ts";

export const restoreLexicon = async ({
  cid,
  did,
  nsid,
  snapshot,
}: {
  readonly cid: string;
  readonly did: string;
  readonly nsid: string;
  readonly snapshot: string;
}) => {
  await assertSnapshot(snapshot);

  const data = await mkdtemp(path.join(tmpdir(), "rat-king-pds-restore-"));

  const plc = createServer((_request, response) => {
    response.writeHead(404).end();
  });

  try {
    await snapshotTree(snapshot, data);
    plc.listen(0, "127.0.0.1");
    await once(plc, "listening");
    const address = plc.address();

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's TCP address is not a Unix socket path.
    if (address === null || typeof address === "string") {
      throw new Error("Local restore PLC fence did not bind.");
    }

    await withPds(
      {
        ...localIdentity(),
        commit: "local-restore",
        data,
        hostname: "restore.example.org",
        localPlc: `http://127.0.0.1:${address.port}`,
      },
      async (origin) => {
        const version = textField(await xrpc(origin, "_health"), "version");
        const restored = await getLexicon(origin, did, nsid);

        if (restored.cid !== cid) {
          throw new Error(
            "Restored Lexicon CID does not match the independently recorded CID."
          );
        }

        console.log(
          `PDS_RESTORE_OK version=${version} did=${did} nsid=${nsid} cid=${cid}`
        );
      }
    );
  } finally {
    await plc[Symbol.asyncDispose]();
    await rm(data, { force: true, recursive: true });
  }
};

if (import.meta.main) {
  process.umask(0o077);
  const [snapshot, did, nsid, cid] = process.argv.slice(2);

  if (
    snapshot === undefined ||
    did === undefined ||
    nsid === undefined ||
    cid === undefined ||
    !/^did:plc:[a-z2-7]{24}$/u.test(did) ||
    !/^dev\.ratking\.board\.[a-zA-Z0-9]+$/u.test(nsid) ||
    !/^[a-z0-9]+$/u.test(cid)
  ) {
    throw new Error(
      "Usage: node restore.ts <completed-snapshot> <publisher-did> <nsid> <expected-cid>"
    );
  }

  await restoreLexicon({ cid, did, nsid, snapshot });
}
