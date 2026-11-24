import { dotAlchemyDirectory, localState, Stack } from "alchemy";
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";

import {
  Host,
  layer as inventoryLayer,
} from "../../packages/alchemy-nest/src/host.ts";
import {
  RemoteFile,
  RemoteFileProvider,
} from "../../packages/alchemy-nest/src/providers.ts";
import { layer as sshLayer } from "../../packages/alchemy-nest/src/ssh.ts";
import {
  OriginHost,
  OriginPort,
  pdsArtifacts,
  ReleaseCommit,
  RotationPublicKey,
  SnapshotRecipient,
  TunnelId,
  UnitPath,
} from "./unit.ts";

const target = Effect.gen(function* target() {
  const hosts = yield* Host;

  return yield* hosts.node(yield* Config.String("RAT_KING_PDS_NODE"));
});

const connection = Layer.unwrap(
  target.pipe(Effect.map((node) => sshLayer(node)))
).pipe(Layer.provide(inventoryLayer), Layer.orDie);

const externalState = Effect.gen(function* externalState() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(path.resolve(import.meta.dirname, "../.."));
  const cwd = yield* fs.realPath(process.cwd());

  const meta = yield* fs.realPath(
    path.resolve(cwd, yield* dotAlchemyDirectory)
  );

  if (
    cwd === root ||
    cwd.startsWith(`${root}/`) ||
    meta === root ||
    meta.startsWith(`${root}/`)
  ) {
    return yield* Effect.die(
      "Run the PDS stack with private Alchemy state outside the checkout."
    );
  }

  const store = path.join(meta, "state");

  if ((yield* fs.exists(store)) && (yield* fs.realPath(store)) !== store) {
    return yield* Effect.die(
      "The private Alchemy state directory must not be a symlink."
    );
  }

  return yield* Effect.void;
});

export default Stack(
  "pds",
  {
    providers: RemoteFileProvider().pipe(Layer.provide(connection)),
    state: localState(),
  },
  Effect.gen(function* pds() {
    yield* externalState;
    const host = yield* target;
    const hostname = yield* Config.schema(OriginHost, "RAT_KING_PDS_HOSTNAME");
    const port = yield* Config.schema(OriginPort, "RAT_KING_PDS_PORT");
    const commit = yield* Config.schema(ReleaseCommit, "RAT_KING_PDS_COMMIT");

    const tunnel = yield* Config.option(
      Config.schema(TunnelId, "RAT_KING_PDS_TUNNEL_ID")
    );

    const rotationPublicKey = yield* Config.schema(
      RotationPublicKey,
      "RAT_KING_PDS_PLC_PUBLIC_KEY"
    );

    const snapshotRecipient = yield* Config.schema(
      SnapshotRecipient,
      "RAT_KING_PDS_SNAPSHOT_RECIPIENT"
    );

    const home = yield* Schema.decodeEffect(UnitPath)(host.home);

    const artifacts = pdsArtifacts({
      commit,
      hostname,
      port,
      rotationPublicKey,
      snapshotRecipient,
      tunnel: Option.getOrUndefined(tunnel),
    });

    for (const [id, artifact] of Object.entries(artifacts)) {
      if (artifact === undefined) {
        continue;
      }

      yield* RemoteFile(id, {
        content: artifact.text,
        mode: 0o600,
        path: `${home}/rat-king-pds-stage/${artifact.name}`,
      });
    }

    return { commit, origin: `https://${hostname}` };
  }).pipe(Effect.provide(inventoryLayer), Effect.orDie)
);
