import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random, RandomProvider } from "alchemy/Random";
import { Effect, Layer, Redacted } from "effect";

import { BucketProvider, BucketResource } from "./bucket-api.ts";
import { textDigest } from "./files.ts";
import type { Node } from "./inventory-schema.ts";
import { weedBinary } from "./pins.ts";
import {
  HostDirectory,
  ReleaseBinary,
  RemoteFile,
  SystemdUnit,
  providers as hostProviders,
} from "./providers.ts";
import { sliceUnit, storeUnit } from "./service-units.ts";
import { storageMaintenanceScript } from "./storage-maintenance-script.ts";
import {
  storageRetentionTimer,
  storageRetentionUnit,
} from "./storage-maintenance.ts";
import { renderUnit } from "./systemd.ts";

export const Slice = (home: string, memoryMax = "4G", cpuQuota = "300%") =>
  SystemdUnit("rat-king-slice", sliceUnit(home, memoryMax, cpuQuota));

export const Bucket = (
  id: string,
  props: {
    readonly host: Node;
    readonly name: string;
    readonly purgeOnDelete?: boolean;
    readonly slice: Output.Output<string>;
    readonly restartGateBundle?: string | undefined;
  }
) =>
  Effect.gen(function* bucket() {
    const { host } = props;

    const root = yield* HostDirectory("binary-root", {
      mode: 0o700,
      path: `${host.home}/.local/share/rat-king`,
    });

    const bin = yield* HostDirectory("bin", {
      mode: 0o700,
      path: Output.interpolate`${root.path}/bin`,
    });

    const configuration = yield* HostDirectory("config-root", {
      mode: 0o700,
      path: `${host.home}/.config/rat-king`,
    });

    const dataRoot = yield* HostDirectory("data-root", {
      mode: 0o700,
      path: host.dataRoot,
    });

    const data = yield* HostDirectory("data", {
      mode: 0o700,
      path: Output.interpolate`${dataRoot.path}/seaweedfs`,
      purgeOnDelete: props.purgeOnDelete ?? false,
      purgeRoot: host.dataRoot,
    });

    const binary = yield* ReleaseBinary("weed", {
      ...weedBinary(`${host.home}/.local/share/rat-king/bin/weed`),
      path: Output.interpolate`${bin.path}/weed`,
    });

    const gate =
      props.restartGateBundle === undefined
        ? undefined
        : yield* RemoteFile("restart-gate", {
            content: props.restartGateBundle,
            mode: 0o600,
            path: Output.interpolate`${bin.path}/restart-gate.mjs`,
          });

    const access = yield* Random("access-key", { bytes: 16 });
    const secret = yield* Random("secret-key", { bytes: 32 });

    const declaration = storeUnit({
      binary: `${host.home}/.local/share/rat-king/bin/weed`,
      config: `${host.home}/.config/rat-king/s3.json`,
      data: `${host.dataRoot}/seaweedfs`,
      home: host.home,
      restartGate:
        gate === undefined
          ? undefined
          : {
              address: host.tailnetIPv4,
              path: `${host.home}/.local/share/rat-king/bin/restart-gate.mjs`,
            },
      restartOn: [],
    });

    const identity = yield* RemoteFile("identity", {
      content: Output.all(access.text, secret.text).pipe(
        Output.map(([accessKey, secretKey]) =>
          Redacted.make(
            JSON.stringify({
              identities: [
                {
                  actions: ["Admin", "Read", "Write", "List", "Tagging"],
                  credentials: [
                    {
                      accessKey: Redacted.value(accessKey),
                      secretKey: Redacted.value(secretKey),
                    },
                  ],
                  name: "rat-king",
                },
              ],
            })
          )
        )
      ),
      mode: 0o600,
      path: Output.interpolate`${configuration.path}/s3.json`,
      rotationOwner: {
        home: host.home,
        name: "rat-king-seaweedfs.service",
        sha256: textDigest(renderUnit(declaration)),
      },
    });

    const unit = yield* SystemdUnit(
      "server",
      Output.all(
        binary.path,
        data.path,
        identity.path,
        identity.sha256,
        binary.sha256,
        props.slice,
        gate?.sha256 ?? props.slice
      ).pipe(
        Output.map((values) => ({
          ...declaration,
          restartOn:
            gate === undefined
              ? [values[3], values[4]]
              : [values[3], values[4], values[6]],
        }))
      )
    );

    const maintenance = yield* RemoteFile("storage-maintenance", {
      content: storageMaintenanceScript,
      mode: 0o600,
      path: Output.interpolate`${bin.path}/storage-maintenance.py`,
    });

    const retention = yield* SystemdUnit(
      "storage-retention",
      Output.all(
        maintenance.path,
        maintenance.sha256,
        unit.sha256,
        props.slice
      ).pipe(
        Output.map(([path, scriptHash, unitHash, sliceHash]) =>
          storageRetentionUnit(host.home, path, [
            scriptHash,
            unitHash,
            sliceHash,
          ])
        )
      )
    );

    yield* SystemdUnit(
      "storage-retention-timer",
      Output.all(retention.sha256, maintenance.sha256).pipe(
        Output.map((ready) => storageRetentionTimer(host.home, ready))
      )
    );

    const resource = yield* BucketResource("bucket", {
      config: identity.path,
      endpoint: "http://127.0.0.1:18333",
      name: props.name,
      ownedStore: Output.all(unit.home, unit.sha256).pipe(
        Output.map(([home, sha256]) => ({
          home,
          name: "rat-king-seaweedfs.service" as const,
          sha256,
        }))
      ),
      purgeOnDelete: props.purgeOnDelete ?? false,
      ready: unit.sha256,
      region: "us-east-1",
    });

    return {
      accessKey: access.text,
      bin: bin.path,
      binaryRoot: root.path,
      bucketName: resource.name,
      configuration: configuration.path,
      dataRoot: dataRoot.path,
      endpoint: resource.endpoint,
      region: resource.region,
      resource,
      restartGate: gate,
      secretKey: secret.text,
      storageMaintenance: maintenance,
    };
  }).pipe(Namespace.push(id));

export type BucketOutput = Effect.Success<ReturnType<typeof Bucket>>;

export const providers = () =>
  Layer.mergeAll(hostProviders(), RandomProvider(), BucketProvider());

export const ObjectStore = { Bucket, Slice, providers };
