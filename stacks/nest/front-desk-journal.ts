import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { Digest, Mac, SecureRandom } from "effect/crypto";

import * as Defs from "../../packages/lexicon/src/defs.ts";
import { withLock } from "../../packages/ratking-client/src/lock.ts";
import { FleetError } from "./stage-config.ts";

const Hex = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u),
  Schema.isMaxLength(64)
);

const Pending = Schema.Struct({
  copy: Defs.EncryptedEnvelope,
  hash: Hex,
  primary: Defs.EncryptedEnvelope,
  step: Schema.Literals(["prepared", "primary-accepted"]),
});

const Done = Schema.Struct({
  hash: Hex,
  messageId: Defs.MessageRef.schema.fields.messageId,
  step: Schema.Literal("done"),
});

const Journal = Schema.fromJsonString(Schema.Union([Pending, Done]));

const maxBytes = 262_144;

const keyBytes = 32;

export const frontDeskRefused = () =>
  new FleetError({ reason: "Front desk delivery not confirmed" });

const readBytes = Effect.fn("Nest.frontDeskJournal.readBytes")(
  function* readBytes(file: string, limit: number) {
    const fs = yield* FileSystem.FileSystem;

    const listed = yield* fs
      .lstat(file)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(null)
        )
      );

    if (listed === null) {
      return null;
    }

    if (
      listed.type !== "File" ||
      listed.size > BigInt(limit) ||
      listed.mode % 512 !== 0o600
    ) {
      return yield* frontDeskRefused();
    }

    const handle = yield* fs.open(file, { flag: "r", noFollow: true });
    const stat = yield* handle.stat;

    if (
      stat.type !== "File" ||
      stat.size !== listed.size ||
      stat.mode % 512 !== 0o600
    ) {
      return yield* frontDeskRefused();
    }

    const bytes = yield* handle.readAlloc(limit + 1);

    if (Option.isNone(bytes) || bytes.value.byteLength !== Number(stat.size)) {
      return yield* frontDeskRefused();
    }

    return bytes.value;
  },
  Effect.scoped
);

const syncDirectory = Effect.fn("Nest.frontDeskJournal.syncDirectory")(
  function* syncDirectory(directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.open(directory, { flag: "r" });

    return yield* file.sync;
  },
  Effect.scoped
);

const writeBytes = Effect.fn("Nest.frontDeskJournal.writeBytes")(
  function* writeBytes(file: string, bytes: Uint8Array) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(file);
    const temp = yield* fs.makeTempFileScoped({ directory, prefix: ".send-" });
    yield* fs.chmod(temp, 0o600);

    const handle = yield* fs.open(temp, { flag: "w", noFollow: true });
    yield* handle.writeAll(bytes);
    yield* handle.sync;
    yield* fs.rename(temp, file);

    return yield* syncDirectory(directory);
  },
  Effect.scoped
);

const readJournal = Effect.fn("Nest.frontDeskJournal.read")(
  function* readJournal(file: string) {
    const bytes = yield* readBytes(file, maxBytes);

    return bytes === null
      ? null
      : yield* Schema.decodeEffect(Journal)(new TextDecoder().decode(bytes), {
          onExcessProperty: "error",
        });
  }
);

const writeJournal = Effect.fn("Nest.frontDeskJournal.write")(
  function* writeJournal(file: string, row: typeof Journal.Type) {
    const text = yield* Schema.encodeEffect(Journal)(row, {
      onExcessProperty: "error",
    });

    const bytes = new TextEncoder().encode(text);

    if (bytes.byteLength > maxBytes) {
      return yield* frontDeskRefused();
    }

    return yield* writeBytes(file, bytes);
  }
);

const loadKey = Effect.fn("Nest.frontDeskJournal.loadKey")(function* loadKey(
  directory: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const file = path.join(directory, ".journal-key");

  const before = yield* readBytes(file, keyBytes);

  if (before !== null) {
    if (before.byteLength !== keyBytes) {
      return yield* frontDeskRefused();
    }

    return yield* Mac.key(Mac.hmacSha256, before);
  }

  const entries = yield* fs.readDirectory(directory);

  if (entries.some((entry) => entry.endsWith(".json"))) {
    return yield* frontDeskRefused();
  }

  const fresh = yield* random.randomBytes(keyBytes);
  yield* writeBytes(file, fresh);

  return yield* Mac.key(Mac.hmacSha256, fresh);
});

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

interface JournalSession {
  readonly read: ReturnType<typeof readJournal>;
  readonly sign: (text: string) => Effect.Effect<string, FleetError>;
  readonly write: (row: typeof Journal.Type) => ReturnType<typeof writeJournal>;
}

const cryptoLayer = Layer.mergeAll(
  Digest.layerWebCrypto,
  Mac.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))
);

export const withFrontDeskJournal = <A, E, R>(
  state: string,
  id: string,
  run: (session: JournalSession) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* journal() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const mac = yield* Mac.Mac;

    const entry = yield* digest.digestHex(
      Digest.sha256,
      new TextEncoder().encode(id)
    );

    const directory = path.join(state, "front-desk-send");
    const root = path.resolve(import.meta.dirname, "../..");
    const canonicalState = yield* fs.realPath(state);

    if (canonicalState === root || canonicalState.startsWith(`${root}/`)) {
      return yield* frontDeskRefused();
    }

    yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
    const canonical = yield* fs.realPath(directory);

    if (canonical !== path.join(canonicalState, "front-desk-send")) {
      return yield* frontDeskRefused();
    }

    yield* syncDirectory(canonicalState);
    const key = yield* withLock(canonical, "key", loadKey(canonical));
    const file = path.join(canonical, `${entry}.json`);

    return yield* withLock(
      canonical,
      entry,
      run({
        read: readJournal(file),
        sign: (text) =>
          mac
            .sign(key, new TextEncoder().encode(text))
            .pipe(Effect.map(hex), Effect.mapError(frontDeskRefused)),
        write: (row) => writeJournal(file, row),
      })
    );
  }).pipe(Effect.provide(cryptoLayer));
