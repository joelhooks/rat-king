import type { BinaryProps } from "../../packages/alchemy-nest/src/release.ts";

export const fleetCelldBuild = {
  buildCommand: "cargo build --locked --release -p celld --bin celld",
  package: "gzip -9 -n -k target/release/celld",
  source: "celld a8e7e36a8b3bb7c7935006428270802be28b9d5d",
};

export const fleetCelldBinary = (home: string): Omit<BinaryProps, "path"> => ({
  asset: {
    format: "gz",
    memberSha256:
      "23593b97d82897bf671b635d2828baf7f4a40b7d3b402082b729655dd8b5c1f1",
  },
  hostSource: `${home}/.local/share/rat-king/artifacts/celld-a8e7e36-x86_64-unknown-linux-gnu.gz`,
  sha256: "612b0f5e40369ab1e7a985ec9657f39525f66145eddc5fdefb6f6eb88499e21c",
  size: 25_340_298,
});
