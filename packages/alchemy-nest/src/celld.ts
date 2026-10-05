import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Effect, Redacted } from "effect";

import { Deployment, DeploymentProvider } from "./deployment.ts";
import type { Node as HostNode } from "./inventory-schema.ts";
import { NodeProvider, NodeResource } from "./node-provider.ts";
import type { BucketOutput } from "./object-store.ts";
import { celldBinary } from "./pins.ts";
import { HostDirectory, ReleaseBinary, RemoteFile } from "./providers.ts";
import { nodeUnit } from "./service-units.ts";

const envQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;

export const Node = (
  id: string,
  props: {
    readonly host: HostNode;
    readonly workerIPv4?: string;
    readonly bucket: BucketOutput;
    readonly purgeOnDelete?: boolean;
  }
) =>
  Effect.gen(function* node() {
    const { host, bucket } = props;
    const workerIPv4 = props.workerIPv4 ?? host.tailnetIPv4;

    const data = yield* HostDirectory("data", {
      mode: 0o700,
      path: Output.interpolate`${bucket.dataRoot}/celld`,
      purgeOnDelete: props.purgeOnDelete ?? false,
      purgeRoot: host.dataRoot,
    });

    const binary = yield* ReleaseBinary("celld", {
      ...celldBinary(`${host.home}/.local/share/rat-king/bin/celld`),
      path: Output.interpolate`${bucket.bin}/celld`,
    });

    const environment = yield* RemoteFile("environment", {
      content: Output.all(
        bucket.accessKey,
        bucket.secretKey,
        bucket.resource.name,
        bucket.resource.endpoint
      ).pipe(
        Output.map(([access, secret, name, endpoint]) =>
          Redacted.make(
            [
              `AWS_ACCESS_KEY_ID=${envQuote(Redacted.value(access))}`,
              `AWS_SECRET_ACCESS_KEY=${envQuote(Redacted.value(secret))}`,
              "AWS_REGION=us-east-1",
              `S3_ENDPOINT=${envQuote(endpoint)}`,
              `CELLD_BUCKET=${envQuote(`s3://${name}`)}`,
              "CELLD_OTEL=0",
              "",
            ].join("\n")
          )
        )
      ),
      mode: 0o600,
      path: Output.interpolate`${bucket.configuration}/celld.env`,
    });

    const unit = yield* NodeResource(
      "node",
      Output.all(
        binary.path,
        data.path,
        environment.path,
        environment.sha256,
        binary.sha256,
        bucket.resource.name
      ).pipe(
        Output.map(([path, directory, env, envHash, binaryHash]) => ({
          ...nodeUnit({
            binary: path,
            data: directory,
            environment: env,
            host,
            restartOn: [envHash, binaryHash],
            workerIPv4,
          }),
          internalUrl: "http://127.0.0.1:18788",
          publicUrl: `http://${workerIPv4}:18787`,
          version: "v0.6.1" as const,
        }))
      )
    );

    return {
      internalUrl: unit.internalUrl,
      publicUrl: unit.publicUrl,
      unit,
      version: unit.version,
    };
  }).pipe(Namespace.push(id));

export const Celld = {
  Deployment,
  Node,
  deploymentProvider: DeploymentProvider,
  providers: NodeProvider,
};
