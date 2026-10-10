export const mintHostScript = String.raw`import { spawnSync } from "node:child_process";

const input = JSON.parse(process.argv[2]);
const listing = spawnSync("secrets", ["--no-update-check", "list"], {
  encoding: "utf8",
});
if (listing.status !== 0) {
  process.exit(1);
}
const secrets = JSON.parse(listing.stdout);
if (
  secrets.ok !== true ||
  !Array.isArray(secrets.result?.secrets) ||
  secrets.result.secrets.some((entry) => entry.name === input.secretName)
) {
  process.exit(1);
}
const generate = async (name, usages) => {
  const pair = await crypto.subtle.generateKey(
    { name, namedCurve: "P-256" },
    true,
    usages
  );
  const { crv, d, kty, x, y } = await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey
  );
  return { crv, d, kty, x, y };
};
const signing = await generate("ECDSA", ["sign", "verify"]);
const agreement = await generate("ECDH", ["deriveBits"]);
const added = spawnSync(
  "secrets",
  ["--no-update-check", "add", input.secretName],
  {
    input: JSON.stringify({ agreement, did: input.did, signing }),
    encoding: "utf8",
  }
);
if (added.status !== 0) {
  process.exit(1);
}
process.stdout.write(input.did + "\n");
`;
