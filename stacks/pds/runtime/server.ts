import { createECDH } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";

import { PDS } from "@atproto/pds";

const readCredential = async (directory: string, name: string) => {
  const content = await readFile(path.join(directory, name), "utf-8");

  return content.trim();
};

export const compressedRotationKey = (scalar: string) => {
  const key = createECDH("secp256k1");

  key.setPrivateKey(Buffer.from(scalar, "hex"));

  return key.getPublicKey("hex", "compressed");
};

export const runPds = async ({
  commit,
  data,
  hostname,
  port,
  secrets,
  localPlc,
  onStarted,
  rotationPublicKey,
  signal,
}: {
  readonly commit: string;
  readonly data: string;
  readonly hostname: string;
  readonly port: number;
  readonly secrets: {
    readonly admin: string;
    readonly jwt: string;
    readonly rotation: string;
  };
  readonly localPlc?: string | undefined;
  readonly onStarted?:
    | ((pds: { readonly server?: Server }) => void)
    | undefined;
  readonly rotationPublicKey: string;
  readonly signal?: AbortSignal | undefined;
}) => {
  const {
    admin: adminPassword,
    jwt: jwtSecret,
    rotation: rotationKey,
  } = secrets;

  if (
    adminPassword.length < 32 ||
    jwtSecret.length < 32 ||
    !/^[\da-f]{64}$/iu.test(rotationKey)
  ) {
    throw new Error("Missing or malformed PDS credentials; values withheld.");
  }

  if (compressedRotationKey(rotationKey) !== rotationPublicKey) {
    throw new Error(
      "PDS PLC rotation credential does not match its public pin."
    );
  }

  const existing = await stat(data);

  if (!existing.isDirectory() || existing.mode % 0o100 !== 0) {
    throw new Error("PDS data directory must exist with private permissions.");
  }

  const blobs = path.join(data, "blobs");
  const temporary = path.join(data, "blob-tmp");
  await mkdir(blobs, { mode: 0o700, recursive: true });
  await mkdir(temporary, { mode: 0o700, recursive: true });

  const did = `did:web:${hostname}`;
  await PDS.run({
    env: {
      acceptingImports: false,
      adminPassword,
      blobstoreDiskLocation: blobs,
      blobstoreDiskTmpLocation: temporary,
      dataDirectory: data,
      didPlcUrl: localPlc,
      hostname,
      inviteRequired: true,
      jwtSecret,
      plcRotationKeyK256PrivateKeyHex: rotationKey,
      port,
      rateLimitsEnabled: true,
      serviceDid: did,
      synchronousFull: true,
      trustedProxies: ["loopback"],
    },
    onCreated: ({ app }) => {
      const listen = app.listen.bind(app);
      app.listen = (upstreamPort) => {
        if (upstreamPort !== port) {
          throw new Error("Unexpected PDS listener configuration.");
        }

        return listen(port, "127.0.0.1");
      };

      app.get("/.well-known/did.json", (req, res) => {
        if (req.get("host") !== hostname) {
          res.sendStatus(404);

          return;
        }

        res.set("X-Rat-King-Commit", commit).json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: did,
          service: [
            {
              id: "#atproto_pds",
              serviceEndpoint: `https://${hostname}`,
              type: "AtprotoPersonalDataServer",
            },
          ],
        });
      });
    },
    onStarted,
    signal,
  });
};

if (import.meta.main) {
  const [hostname, port, data, commit, rotationPublicKey] =
    process.argv.slice(2);

  if (
    hostname === undefined ||
    data === undefined ||
    commit === undefined ||
    !/^[a-f0-9]{40}$/u.test(commit) ||
    rotationPublicKey === undefined ||
    !/^0[23][a-f0-9]{64}$/u.test(rotationPublicKey) ||
    !/^\d{4,5}$/u.test(port ?? "") ||
    Number(port) < 1024 ||
    Number(port) > 65_535
  ) {
    throw new Error(
      "Expected hostname, unprivileged port, data directory, release commit and PLC public pin."
    );
  }

  const credentials = process.env.CREDENTIALS_DIRECTORY;

  if (credentials === undefined || credentials === "") {
    throw new Error("Systemd credential directory is required.");
  }

  const secrets = {
    admin: await readCredential(credentials, "admin"),
    jwt: await readCredential(credentials, "jwt"),
    rotation: await readCredential(credentials, "plc"),
  };

  await runPds({
    commit,
    data,
    hostname,
    port: Number(port),
    rotationPublicKey,
    secrets,
  });
}
