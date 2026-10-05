import { Crypto, Effect, FileSystem, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";

import { refuse } from "./files.ts";
import { must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { s3Script } from "./s3-script.ts";

const scope = (name: string, argv: readonly string[]) => [
  "systemd-run",
  "--user",
  "--scope",
  "--quiet",
  `--unit=${name}`,
  "--slice=rat-king.slice",
  "--property=MemoryMax=64M",
  "--property=MemorySwapMax=0",
  "--property=CPUQuota=10%",
  "--property=TasksMax=64",
  "--",
  "nice",
  "-n",
  "10",
  ...argv,
];

const Identity = Schema.Struct({
  identities: Schema.Array(
    Schema.Struct({
      credentials: Schema.Array(
        Schema.Struct({ accessKey: Schema.String, secretKey: Schema.String })
      ),
    })
  ),
});

const credentialRedactions = Effect.fn("Probe.credentialRedactions")(
  function* credentials(shell: Interface, config: string) {
    const bytes = yield* shell.read(config);

    if (bytes === undefined) {
      return yield* refuse("Probe identity file is missing.");
    }

    const identity = yield* Schema.decodeEffect(
      Schema.fromJsonString(Identity)
    )(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError(() => refuse("Probe identity file is malformed."))
    );

    return identity.identities.flatMap((entry) =>
      entry.credentials.flatMap((pair) => [
        Redacted.make(pair.accessKey),
        Redacted.make(pair.secretKey),
      ])
    );
  }
);

export const probeEnvironment = Effect.fn("Probe.environment")(
  function* environment(shell: Interface, home: string) {
    const bytes = yield* shell.read(`${home}/.config/rat-king/celld.env`);

    if (bytes === undefined) {
      return yield* refuse("Probe environment file is missing.");
    }

    const lines = new TextDecoder().decode(bytes).split("\n");

    const decode = (key: string) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.String))(
        lines
          .find((line) => line.startsWith(`${key}=`))
          ?.slice(key.length + 1) ?? ""
      ).pipe(
        Effect.mapError(() => refuse("Probe environment field is malformed."))
      );

    const location = yield* decode("CELLD_BUCKET");

    if (!location.startsWith("s3://")) {
      return yield* refuse("Probe environment is not an S3 bucket.");
    }

    return {
      bucket: location.slice(5),
      endpoint: yield* decode("S3_ENDPOINT"),
      redactions: yield* credentialRedactions(
        shell,
        `${home}/.config/rat-king/s3.json`
      ),
    };
  }
);

export const diagnoseProbe = Effect.fn("Celld.diagnoseProbe")(
  function* diagnose(shell: Interface, input: { readonly home: string }) {
    const crypto = yield* Crypto.Crypto;

    const environment = yield* probeEnvironment(shell, input.home);

    const result = yield* shell.exec(
      scope(`rat-king-probe-${yield* crypto.randomUUIDv4}`, [
        "sh",
        "-c",
        'set -a; . "$1"; TOKIO_WORKER_THREADS=2; exec "$2" diagnose --listen 127.0.0.1:0 --internal-listen 127.0.0.1:0 2>&1',
        "probe",
        `${input.home}/.config/rat-king/celld.env`,
        `${input.home}/.local/share/rat-king/bin/celld`,
      ]),
      { redactions: environment.redactions }
    );

    const line = result.stdout
      .split("\n")
      .find((entry) => /\bok\s+bucket conditional write\b/u.test(entry));

    if (result.code !== 0 || line === undefined) {
      return yield* refuse(
        `celld diagnose failed; stop and ask the owner before proceeding.\n${result.stdout}\n${result.stderr ?? ""}`
      );
    }

    return line.trim();
  }
);

const Race = Schema.Struct({
  preconditions: Schema.Int,
  statuses: Schema.Array(Schema.Int),
  winners: Schema.Int,
});

export const raceProbe = Effect.fn("ObjectStore.raceProbe")(function* race(
  shell: Interface,
  input: {
    readonly config: string;
    readonly endpoint: string;
    readonly name: string;
  }
) {
  const crypto = yield* Crypto.Crypto;

  const result = yield* shell.exec(
    scope(`rat-king-probe-${yield* crypto.randomUUIDv4}`, [
      "python3",
      "-c",
      s3Script,
      input.config,
      input.endpoint,
      input.name,
      "race",
    ]),
    { redactions: yield* credentialRedactions(shell, input.config) }
  );

  if (result.code !== 0) {
    return yield* refuse(
      `Race command failed; stop and ask the owner.\n${result.stdout}\n${result.stderr ?? ""}`
    );
  }

  const tally = yield* Schema.decodeEffect(Schema.fromJsonString(Race))(
    result.stdout
  ).pipe(Effect.mapError(() => refuse("Malformed race tally.")));

  if (
    tally.winners !== 1 ||
    tally.preconditions !== 49 ||
    tally.statuses.length !== 50
  ) {
    return yield* refuse(
      `Conditional race failed: ${JSON.stringify(tally)}; stop and ask the owner.`
    );
  }

  return tally;
});

export const bootstrapProbe = Effect.fn("Celld.bootstrapProbe")(
  function* bootstrap(shell: Interface, input: { readonly home: string }) {
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;

    const source = yield* fs.readFile(
      new URL("../test/fixtures/bootstrap-worker/index.js", import.meta.url)
        .pathname
    );

    const directory = `${input.home}/.config/rat-king/bootstrap-${yield* crypto.randomUUIDv4}`;
    const entry = `${directory}/index.js`;
    const config = `${directory}/wrangler.json`;
    yield* shell.mkdir({ mode: 0o700, path: directory });

    return yield* Effect.gen(function* publish() {
      yield* shell.write({ bytes: source, mode: 0o600, path: entry });
      yield* shell.write({
        bytes: new TextEncoder().encode(
          JSON.stringify({
            compatibility_date: "2026-10-04",
            main: "index.js",
            name: "rat-king-bootstrap",
            no_bundle: true,
          })
        ),
        mode: 0o600,
        path: config,
      });

      const environment = yield* probeEnvironment(shell, input.home);

      const result = yield* shell.exec(
        scope(`rat-king-probe-${yield* crypto.randomUUIDv4}`, [
          "sh",
          "-c",
          'set -a; . "$1"; TOKIO_WORKER_THREADS=2; exec "$2" deploy "$3"',
          "probe",
          `${input.home}/.config/rat-king/celld.env`,
          `${input.home}/.local/share/rat-king/bin/celld`,
          directory,
        ]),
        { redactions: environment.redactions }
      );

      if (result.code !== 0) {
        return yield* refuse(
          `Bootstrap deploy failed.\n${result.stdout}\n${result.stderr ?? ""}`
        );
      }

      return result.stdout;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* cleanup() {
          yield* shell.remove(entry);
          yield* shell.remove(config);
          yield* shell.rmdir(directory);
        }).pipe(Effect.orDie)
      )
    );
  }
);

export const bootstrapCheck = Effect.fn("Celld.bootstrapCheck")(function* check(
  url: string
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(url);

  if (
    response.status !== 200 ||
    (yield* response.text) !== "rat-king bootstrap\n"
  ) {
    return yield* refuse("Bootstrap Worker response did not match.");
  }

  return "bootstrap body matched";
});

export const listenerProbe = Effect.fn("Celld.listenerProbe")(
  function* listeners(
    shell: Interface,
    publicIPv4: string,
    nodeExpected: boolean
  ) {
    const text = yield* must(shell, ["ss", "-ltnp"]);

    const lines = text
      .split("\n")
      .filter((line) => /users:\(\("(?:weed|celld)"/u.test(line));

    const expected = new Set([
      19_333,
      18_081,
      18_888,
      18_333,
      29_333,
      28_081,
      28_888,
      28_333,
      ...(nodeExpected ? [18_787, 18_788] : []),
    ]);

    if (lines.length !== expected.size) {
      return yield* refuse("Unexpected listener count.");
    }

    for (const line of lines) {
      const local = line.trim().split(/\s+/u)[3] ?? "";
      const port = Number(local.slice(local.lastIndexOf(":") + 1));

      if (
        !expected.delete(port) ||
        local !== `${port === 18_787 ? publicIPv4 : "127.0.0.1"}:${port}`
      ) {
        return yield* refuse("Unexpected listener interface or port.");
      }
    }

    return lines.join("\n");
  }
);
