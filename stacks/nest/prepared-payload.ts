import { Effect, Schema } from "effect";

import { digest } from "../../packages/alchemy-nest/src/files.ts";
import { fleetCelldBinary } from "./celld-build.ts";
import { Sha } from "./ship-config.ts";
import { FleetError } from "./stage-config.ts";

export const maxPreparedBytes = 32 * 1024 * 1024;

const encoder = new TextEncoder();

export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const PackageVersion = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u),
  Schema.isMaxLength(128)
);

const Payload = Schema.Struct({
  bytes: Schema.Int.check(
    Schema.isBetween({ maximum: maxPreparedBytes, minimum: 1 })
  ),
  sha256: Sha256,
  text: Schema.NonEmptyString,
});

const Asset = Schema.Struct({
  archive: Sha256,
  binary: Sha256,
  size: Schema.Int,
});

const Container = Schema.fromJsonString(
  Schema.Struct({
    celld: Asset,
    commit: Sha,
    format: Schema.Literal("rat-king/fleet/v1"),
    payloads: Schema.Struct({
      backup: Payload,
      cli: Payload,
      restart: Payload,
      worker: Payload,
    }),
    version: PackageVersion,
  })
);

interface Destinations {
  readonly backup: string;
  readonly cli: string;
  readonly restart: string;
  readonly worker: string;
}

interface Identity {
  readonly commit: string;
  readonly version: string;
}

export interface PreparedFleetPayload extends Identity, Destinations {}

const celld = () => {
  const pin = fleetCelldBinary("");

  return {
    archive: pin.sha256,
    binary: pin.asset.memberSha256,
    size: pin.size,
  };
};

const encode = (text: string) => {
  const bytes = encoder.encode(text);

  return { bytes: bytes.length, sha256: digest(bytes), text };
};

export const encodePrepared = ({
  backup,
  cli,
  commit,
  restart,
  version,
  worker,
}: PreparedFleetPayload) =>
  encoder.encode(
    JSON.stringify({
      celld: celld(),
      commit,
      format: "rat-king/fleet/v1",
      payloads: {
        backup: encode(backup),
        cli: encode(cli),
        restart: encode(restart),
        worker: encode(worker),
      },
      version,
    })
  );

const validPayload = (entry: typeof Payload.Type) => {
  const bytes = encoder.encode(entry.text);

  return (
    bytes.length === entry.bytes &&
    digest(bytes) === entry.sha256 &&
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) ===
      entry.text
  );
};

const badContainer = () =>
  new FleetError({
    reason: "Prepared fleet bundle format or identity refused",
  });

export const decodePrepared = Effect.fn("Ship.decodePrepared")(
  function* decodePrepared(
    bytes: Uint8Array,
    expected: { readonly commit: string; readonly sha256: string }
  ) {
    if (bytes.length > maxPreparedBytes || digest(bytes) !== expected.sha256) {
      return yield* new FleetError({
        reason: "Prepared fleet bundle pin mismatch",
      });
    }

    const text = yield* Effect.try({
      catch: badContainer,
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes
        ),
    });

    const decoded = yield* Schema.decodeEffect(Container, {
      onExcessProperty: "error",
    })(text).pipe(Effect.mapError(badContainer));

    const pin = celld();
    const { commit, payloads, version } = decoded;

    if (
      JSON.stringify(decoded) !== text ||
      commit !== expected.commit ||
      decoded.celld.archive !== pin.archive ||
      decoded.celld.binary !== pin.binary ||
      decoded.celld.size !== pin.size ||
      !Object.values(payloads).every(validPayload)
    ) {
      return yield* badContainer();
    }

    return Object.freeze({
      backup: payloads.backup.text,
      cli: payloads.cli.text,
      commit,
      restart: payloads.restart.text,
      version,
      worker: payloads.worker.text,
    });
  }
);
