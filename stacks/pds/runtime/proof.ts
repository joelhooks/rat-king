import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, get, IncomingMessage } from "node:http";
import type { IncomingMessage as Request, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";

import { assureValidCreationOp, formatDidDoc } from "@did-plc/lib";

import {
  getLexicon,
  localIdentity,
  textField,
  withPds,
  xrpc,
} from "./local.ts";
import { restoreLexicon } from "./restore.ts";
import { snapshotTree } from "./snapshot.ts";

process.umask(0o077);

const nsid = "dev.ratking.board.proof";

const hostname = "pds.example.org";

const handle = `lexicons.${hostname}`;

const commit = "a".repeat(40);

const identity = localIdentity();

const email = process.env.PDS_PROOF_EMAIL;

if (email === undefined || email === "") {
  throw new Error(
    "Set PDS_PROOF_EMAIL to a synthetic address for the loopback PLC proof."
  );
}

const account = {
  email,
  handle,
  password: localIdentity().secrets.admin,
};

const directory = new Map<string, ReturnType<typeof formatDidDoc>>();

const localDirectory = async (req: Request, res: ServerResponse) => {
  try {
    const did = decodeURIComponent(req.url?.slice(1) ?? "");

    if (req.method === "POST") {
      assert.equal(directory.has(did), false);
      directory.set(
        did,
        formatDidDoc(await assureValidCreationOp(did, await json(req)))
      );
      res.writeHead(200).end();

      return;
    }

    const document = directory.get(did);

    if (req.method === "GET" && document !== undefined) {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(document));
    } else {
      res.writeHead(404).end();
    }
  } catch {
    res.writeHead(400).end();
  }
};

const originServiceDid = async (origin: string, host: string) => {
  const request = get(`${origin}/.well-known/did.json`, {
    headers: { Host: host },
    signal: AbortSignal.timeout(10_000),
  });

  const event = await once(request, "response");
  const response: unknown = event[0];

  assert.ok(response instanceof IncomingMessage);

  return response;
};

await using plc = createServer((req, res) => {
  void localDirectory(req, res);
});

const root = await mkdtemp(path.join(tmpdir(), "rat-king-pds-proof-"));

try {
  const data = path.join(root, "state");
  const snapshot = path.join(root, "snapshot");

  await mkdir(data, { mode: 0o700 });
  await mkdir(snapshot, { mode: 0o700 });
  plc.listen(0, "127.0.0.1");
  await once(plc, "listening");

  const address = plc.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's TCP address is not a Unix socket path.
  assert.ok(address !== null && typeof address !== "string");

  const localPlc = `http://127.0.0.1:${address.port}`;

  const result = await withPds(
    { ...identity, commit, data, hostname, localPlc },
    async (origin) => {
      const version = textField(await xrpc(origin, "_health"), "version");

      assert.equal(version, "0.5.65");

      const wrongHost = await originServiceDid(
        origin,
        "unknown.example.invalid"
      );

      assert.equal(wrongHost.statusCode, 404);
      wrongHost.resume();

      const service = await originServiceDid(origin, hostname);

      assert.equal(service.headers["x-rat-king-commit"], commit);
      assert.equal(textField(await json(service), "id"), `did:web:${hostname}`);
      await assert.rejects(
        xrpc(origin, "com.atproto.server.createAccount", { body: account }),
        /InvalidInviteCode/u
      );

      const invitation = await xrpc(
        origin,
        "com.atproto.server.createInviteCode",
        {
          authorization: `Basic ${Buffer.from(`admin:${identity.secrets.admin}`).toString("base64")}`,
          body: { useCount: 1 },
        }
      );

      const createdAccount = await xrpc(
        origin,
        "com.atproto.server.createAccount",
        { body: { ...account, inviteCode: textField(invitation, "code") } }
      );

      const did = textField(createdAccount, "did");
      const published = directory.get(did);

      assert.match(did, /^did:plc:/u);
      assert.equal(published?.id, did);
      assert.deepEqual(published?.alsoKnownAs, [`at://${handle}`]);
      assert.equal(
        published.service[0]?.serviceEndpoint,
        `https://${hostname}`
      );

      const uri = `at://${did}/com.atproto.lexicon.schema/${nsid}`;

      const record = {
        $type: "com.atproto.lexicon.schema",
        defs: { main: { properties: {}, type: "object" } },
        id: nsid,
        lexicon: 1,
      };

      const created = await xrpc(origin, "com.atproto.repo.putRecord", {
        authorization: `Bearer ${textField(createdAccount, "accessJwt")}`,
        body: {
          collection: "com.atproto.lexicon.schema",
          record,
          repo: did,
          rkey: nsid,
          validate: true,
        },
      });

      const fetched = await getLexicon(origin, did, nsid);

      assert.equal(textField(created, "uri"), uri);
      assert.deepEqual(fetched.value, record);
      assert.equal(fetched.cid, textField(created, "cid"));
      console.log(
        `PDS_LEXICON_OK version=${version} did=${did} nsid=${nsid} cid=${fetched.cid}`
      );

      return { cid: fetched.cid, did };
    }
  );

  await writeFile(path.join(data, "blobs", "snapshot-fixture"), "blob bytes");
  await snapshotTree(data, snapshot);
  assert.equal(
    await readFile(path.join(snapshot, "blobs", "snapshot-fixture"), "utf-8"),
    "blob bytes"
  );
  await restoreLexicon({ ...result, nsid, snapshot });
} finally {
  await rm(root, { force: true, recursive: true });
}
