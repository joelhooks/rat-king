import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { cryptoOperation } from "../../packages/envelope/src/webcrypto.ts";
import * as Defs from "../../packages/lexicon/src/defs.ts";
import { withLock } from "../../packages/ratking-client/src/lock.ts";
import { FleetError } from "./stage-config.ts";

const Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

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

export const frontDeskRefused = () =>
  new FleetError({ reason: "Front desk delivery not confirmed" });

export const digestText = (text: string) =>
  cryptoOperation(
    crypto.subtle.digest.bind(
      crypto.subtle,
      "SHA-256",
      new TextEncoder().encode(text)
    )
  ).pipe(
    Effect.map((hash) =>
      Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("")
    ),
    Effect.mapError(frontDeskRefused)
  );

const readJournal = Effect.fn("Nest.frontDeskJournal.read")(
  function* readJournal(file: string) {
    const fs = yield* FileSystem.FileSystem;

    const stat = yield* fs
      .stat(file)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(null)
        )
      );

    if (stat === null) {
      return null;
    }

    if (stat.type !== "File" || stat.size > BigInt(maxBytes)) {
      return yield* frontDeskRefused();
    }

    const handle = yield* fs.open(file, { flag: "r", noFollow: true });
    const bytes = yield* handle.readAlloc(maxBytes + 1);

    if (Option.isNone(bytes) || bytes.value.byteLength !== Number(stat.size)) {
      return yield* frontDeskRefused();
    }

    return yield* Schema.decodeEffect(Journal)(
      new TextDecoder().decode(bytes.value),
      { onExcessProperty: "error" }
    );
  },
  Effect.scoped
);

const writeJournal = Effect.fn("Nest.frontDeskJournal.write")(
  function* writeJournal(file: string, row: typeof Journal.Type) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(file);

    const text = yield* Schema.encodeEffect(Journal)(row, {
      onExcessProperty: "error",
    });

    const bytes = new TextEncoder().encode(text);

    if (bytes.byteLength > maxBytes) {
      return yield* frontDeskRefused();
    }

    const temp = yield* fs.makeTempFileScoped({ directory, prefix: ".send-" });
    yield* fs.chmod(temp, 0o600);

    const handle = yield* fs.open(temp, { flag: "w", noFollow: true });
    yield* handle.writeAll(bytes);
    yield* handle.sync;
    yield* fs.rename(temp, file);

    const parent = yield* fs.open(directory, { flag: "r" });

    return yield* parent.sync;
  },
  Effect.scoped
);

export const withFrontDeskJournal = <A, E, R>(
  state: string,
  id: string,
  run: (methods: {
    readonly read: ReturnType<typeof readJournal>;
    readonly write: (
      row: typeof Journal.Type
    ) => ReturnType<typeof writeJournal>;
  }) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* journal() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const key = yield* digestText(id);

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

    const file = path.join(canonical, `${key}.json`);

    return yield* withLock(
      canonical,
      key,
      run({ read: readJournal(file), write: (row) => writeJournal(file, row) })
    );
  });
