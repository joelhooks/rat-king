import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random, RandomProvider } from "alchemy/Random";
import { Effect, Layer, Redacted } from "effect";

import { BucketProvider, BucketResource } from "./bucket-api.ts";
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

export const Slice = (home: string, memoryMax = "4G") =>
  SystemdUnit("rat-king-slice", sliceUnit(home, memoryMax));

export const Bucket = (
  id: string,
  props: {
    readonly host: Node;
    readonly name: string;
    readonly purgeOnDelete?: boolean;
    readonly slice: Output.Output<string>;
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

    const access = yield* Random("access-key", { bytes: 16 });
    const secret = yield* Random("secret-key", { bytes: 32 });

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
    });

    const unit = yield* SystemdUnit(
      "server",
      Output.all(
        binary.path,
        data.path,
        identity.path,
        identity.sha256,
        binary.sha256,
        props.slice
      ).pipe(
        Output.map(([path, directory, config, configHash, binaryHash]) =>
          storeUnit({
            binary: path,
            config,
            data: directory,
            home: host.home,
            restartOn: [configHash, binaryHash],
          })
        )
      )
    );

    const resource = yield* BucketResource("bucket", {
      config: identity.path,
      endpoint: "http://127.0.0.1:18333",
      name: props.name,
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
      secretKey: secret.text,
    };
  }).pipe(Namespace.push(id));

export type BucketOutput = Effect.Success<ReturnType<typeof Bucket>>;

export const providers = () =>
  Layer.mergeAll(hostProviders(), RandomProvider(), BucketProvider());

export const ObjectStore = { Bucket, Slice, providers };
