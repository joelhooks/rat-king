import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { RandomProvider } from "alchemy/Random";
import { Effect, Layer, Schema } from "effect";

import { BucketProvider, BucketResource } from "./bucket-api.ts";
import { refuse, textDigest } from "./files.ts";
import { instanceStoreUnit } from "./instance-units.ts";
import { InstanceNameSchema, validateInstance } from "./instance.ts";
import type { InstanceProps } from "./instance.ts";
import type { Node } from "./inventory-schema.ts";
import { awaitModule } from "./late-module.ts";
import { renderMaintenanceScript } from "./maintenance-render.ts";
import { weedBinary } from "./pins.ts";
import {
  HostDirectory,
  ReleaseBinary,
  RemoteFile,
  SystemdUnit,
  providers as hostProviders,
} from "./providers.ts";
import { sliceUnit } from "./service-units.ts";
import type { ServiceLimits } from "./service-units.ts";
import {
  storageGrowTimer,
  storageGrowUnit,
  storageRetentionTimer,
  storageRetentionUnit,
} from "./storage-maintenance.ts";
import { identityContent, storeCredentials } from "./store-credentials.ts";
import type { CredentialNames } from "./store-credentials.ts";
import { renderUnit } from "./systemd.ts";

export interface SliceProps {
  readonly cpuQuota?: string;
  readonly home: string;
  readonly instance?: string;
  readonly memoryHigh?: string;
  readonly memoryMax?: string;
}

export const Slice = (
  input: string | SliceProps,
  memoryMax = "4G",
  cpuQuota = "300%"
) =>
  Effect.gen(function* slice() {
    const props = Schema.is(Schema.String)(input)
      ? { cpuQuota, home: input, memoryMax }
      : input;

    const instance =
      props.instance === undefined
        ? "rat-king"
        : yield* Schema.decodeEffect(InstanceNameSchema)(props.instance).pipe(
            Effect.mapError(() => refuse("Invalid slice instance."))
          );

    return yield* SystemdUnit(
      `${instance}-slice`,
      sliceUnit(props.home, props.memoryMax, props.cpuQuota, props)
    );
  });

export interface StoreProps extends InstanceProps, ServiceLimits {
  readonly credentials?: CredentialNames;
  readonly dataRoot?: string;
  readonly legacyRandomCredentials?: boolean;
  readonly host: Node;
  readonly name: string;
  readonly prepared?: readonly Output.Output<string>[];
  readonly purgeOnDelete?: boolean;
  readonly restartGate?: false;
  readonly restartGateBundle?: string | undefined;
  readonly slice: Output.Output<string>;
  readonly volumeMax?: number;
}

export const Bucket = (id: string, props: StoreProps) =>
  Effect.gen(function* bucket() {
    const { host } = props;
    const layout = yield* validateInstance(host, props);

    if (
      props.volumeMax !== undefined &&
      (!Number.isSafeInteger(props.volumeMax) || props.volumeMax < 1)
    ) {
      return yield* refuse("Invalid volume maximum.");
    }

    const root = yield* HostDirectory("binary-root", {
      mode: 0o700,
      path: layout.binaryRoot,
    });

    const bin = yield* HostDirectory("bin", {
      mode: 0o700,
      path: Output.interpolate`${root.path}/bin`,
    });

    const configuration = yield* HostDirectory("config-root", {
      mode: 0o700,
      path: layout.configuration,
    });

    const dataRoot = yield* HostDirectory("data-root", {
      mode: 0o700,
      path: layout.dataRoot,
    });

    const data = yield* HostDirectory("data", {
      mode: 0o700,
      path: Output.interpolate`${dataRoot.path}/seaweedfs`,
      purgeOnDelete: props.purgeOnDelete ?? false,
      purgeRoot: layout.dataRoot,
    });

    const binary = yield* ReleaseBinary("weed", {
      ...weedBinary(`${layout.bin}/weed`),
      path: Output.interpolate`${bin.path}/weed`,
    });

    const restartGateBundle =
      props.restartGate === false
        ? undefined
        : (props.restartGateBundle ??
          (layout.instance === "rat-king"
            ? undefined
            : yield* Effect.suspend(() =>
                awaitModule(
                  import("./operator-build.ts"),
                  "Operator bundle module unavailable"
                )
              ).pipe(
                Effect.flatMap(({ operatorBundle }) =>
                  operatorBundle(
                    new URL("instance-restart-gate.ts", import.meta.url)
                      .pathname
                  )
                )
              )));

    const gate =
      restartGateBundle === undefined
        ? undefined
        : yield* RemoteFile("restart-gate", {
            content: restartGateBundle,
            mode: 0o600,
            path: Output.interpolate`${bin.path}/restart-gate.mjs`,
          });

    const credentials = yield* storeCredentials(props);

    const declaration = instanceStoreUnit(host, layout, {
      cpuQuota: props.cpuQuota,
      memoryMax: props.memoryMax,
      oomPolicy: props.oomPolicy,
      restartGate: gate !== undefined,
      volumeMax: props.volumeMax,
    });

    const identity = yield* RemoteFile("identity", {
      ...identityContent(credentials, layout.instance),
      mode: 0o600,
      path: Output.interpolate`${configuration.path}/s3.json`,
      rotationOwner: {
        home: host.home,
        name: layout.storeUnit,
        sha256: textDigest(renderUnit(declaration)),
      },
    });

    const unit = yield* SystemdUnit("server", {
      ...declaration,
      prepared: [
        binary.path,
        data.path,
        identity.path,
        props.slice,
        gate?.sha256 ?? props.slice,
        ...(props.prepared ?? []),
      ],
      restartOn: Output.all(identity.sha256, binary.sha256),
    });

    const maintenance = yield* RemoteFile("storage-maintenance", {
      content: renderMaintenanceScript(host, props).text,
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
          storageRetentionUnit(
            host.home,
            path,
            [scriptHash, unitHash, sliceHash],
            layout
          )
        )
      )
    );

    yield* SystemdUnit(
      "storage-retention-timer",
      Output.all(retention.sha256, maintenance.sha256).pipe(
        Output.map((ready) => storageRetentionTimer(host.home, ready, layout))
      )
    );

    const grow = yield* SystemdUnit(
      "storage-grow",
      Output.all(
        maintenance.path,
        maintenance.sha256,
        unit.sha256,
        props.slice
      ).pipe(
        Output.map(([path, scriptHash, unitHash, sliceHash]) =>
          storageGrowUnit(
            host.home,
            path,
            [scriptHash, unitHash, sliceHash],
            layout
          )
        )
      )
    );

    yield* SystemdUnit(
      "storage-grow-timer",
      Output.all(grow.sha256, maintenance.sha256).pipe(
        Output.map((ready) => storageGrowTimer(host.home, ready, layout))
      )
    );

    const resource = yield* BucketResource("bucket", {
      config: identity.path,
      endpoint: `http://127.0.0.1:${layout.ports.s3}`,
      name: props.name,
      ownedStore: Output.all(unit.home, unit.sha256).pipe(
        Output.map(([home, sha256]) => ({
          home,
          name: layout.storeUnit,
          sha256,
        }))
      ),
      purgeOnDelete: props.purgeOnDelete ?? false,
      ready: unit.sha256,
      region: "us-east-1",
    });

    return {
      bin: bin.path,
      binaryRoot: root.path,
      bucketName: resource.name,
      configuration: configuration.path,
      credentials,
      dataRoot: dataRoot.path,
      endpoint: resource.endpoint,
      layout,
      region: resource.region,
      resource,
      restartGate: gate,
      storageMaintenance: maintenance,
    };
  }).pipe(Namespace.push(id));

export type BucketOutput = Effect.Success<ReturnType<typeof Bucket>>;

export const providers = () =>
  Layer.mergeAll(hostProviders(), RandomProvider(), BucketProvider());

export const ObjectStore = { Bucket, Slice, providers };
