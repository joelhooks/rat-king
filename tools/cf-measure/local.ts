import { createRequire } from "node:module";
import { createServer } from "node:net";

import { Duration, Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { hostedBindings, hostedVars } from "../../apps/mailbox/src/bindings.ts";
import { prepareDeployment } from "../../packages/alchemy-nest/src/deployment-build.ts";
import { GeneratedConfiguration } from "../../packages/alchemy-nest/src/deployment-config.ts";
import type { Inputs } from "./identities.ts";
import { MeasureError } from "./model.ts";

const workerd = Schema.decodeUnknownSync(
  Schema.Struct({ compatibilityDate: Schema.String, default: Schema.String })
)(createRequire(import.meta.url)("workerd"));

const quote = (value: string) => JSON.stringify(value);

export const workerdConfig = (input: {
  readonly configuration: typeof GeneratedConfiguration.Type;
  readonly secrets: Readonly<Record<string, string>>;
  readonly port: number;
  readonly compatibilityDate: string;
  readonly storage: string;
}) => {
  const objects = input.configuration.durable_objects.bindings;

  const bindings = [
    ...objects.map(
      (binding) =>
        `(name = ${quote(binding.name)}, durableObjectNamespace = (className = ${quote(binding.class_name)}))`
    ),
    ...Object.entries({ ...input.configuration.vars, ...input.secrets }).map(
      ([name, value]) => `(name = ${quote(name)}, text = ${quote(value)})`
    ),
  ];

  const namespaces = objects.map(
    (binding) =>
      `(className = ${quote(binding.class_name)}, enableSql = true, uniqueKey = ${quote(binding.class_name)})`
  );

  const date =
    input.configuration.compatibility_date < input.compatibilityDate
      ? input.configuration.compatibility_date
      : input.compatibilityDate;

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "storage", disk = (path = ${quote(input.storage)}, writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${input.port}", http = (), service = "main")],
);

const worker :Workerd.Worker = (
  modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
  compatibilityDate = ${quote(date)},
  bindings = [${bindings.join(", ")}],
  durableObjectNamespaces = [${namespaces.join(", ")}],
  durableObjectStorage = (localDisk = "storage"),
);
`;
};

const Address = Schema.Struct({ port: Schema.Number });

const freePort = Effect.callback<number, MeasureError>((resume) => {
  const server = createServer();

  server.once("error", () => {
    resume(Effect.fail(new MeasureError({ reason: "No free local port" })));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();

    server.close(() => {
      resume(
        Schema.is(Address)(address)
          ? Effect.succeed(address.port)
          : Effect.fail(new MeasureError({ reason: "No free local port" }))
      );
    });
  });
});

const supervise = Effect.fn("Measure.supervise")(function* supervise(
  directory: string,
  port: number
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  yield* spawner.spawn(
    ChildProcess.make(
      workerd.default,
      ["serve", "--experimental", "config.capnp"],
      { cwd: directory, stderr: "ignore", stdin: "ignore", stdout: "ignore" }
    )
  );

  const http = yield* HttpClient.HttpClient;

  yield* http.get(`http://127.0.0.1:${port}/`).pipe(
    Effect.mapError(
      () => new MeasureError({ reason: "Local workerd never started" })
    ),
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(100)),
      times: 100,
    })
  );
});

export const serveLocal = Effect.fn("Measure.serveLocal")(function* serveLocal(
  inputs: typeof Inputs.Type,
  documents: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();

  const entrypoint = path.resolve(
    import.meta.dirname,
    "../../apps/mailbox/src/hosted-worker.ts"
  );

  const prepared = yield* prepareDeployment(entrypoint, hostedBindings, {
    commit: "local",
    documents,
    vars: hostedVars({
      bundleDocuments: true,
      documents,
      gatewayModel: "",
      gatewayUrl: "",
      hostedDid: inputs.hosted.did,
      model: "faux",
      serviceDid: inputs.service.did,
      sidecar: false,
    }),
    version: "local",
  }).pipe(
    Effect.mapError(
      () => new MeasureError({ reason: "Hosted bundle build failed" })
    )
  );

  const configuration = yield* Schema.decodeEffect(
    Schema.fromJsonString(GeneratedConfiguration)
  )(prepared.configuration).pipe(
    Effect.mapError(
      () => new MeasureError({ reason: "Invalid generated configuration" })
    )
  );

  const port = yield* freePort;
  const storage = path.join(directory, "storage");

  yield* fs.makeDirectory(storage, { recursive: true });
  yield* fs.writeFileString(
    path.join(directory, "worker.mjs"),
    prepared.bundle
  );
  yield* fs.writeFileString(
    path.join(directory, "config.capnp"),
    workerdConfig({
      compatibilityDate: workerd.compatibilityDate,
      configuration,
      port,
      secrets: {
        AGENT_IDENTITIES_CREDENTIAL: JSON.stringify([inputs.hosted]),
      },
      storage,
    })
  );
  yield* supervise(directory, port);

  return `http://127.0.0.1:${port}`;
});
