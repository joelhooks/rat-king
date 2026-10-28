import { Crypto, Effect, FileSystem, Path, Schema } from "effect";

import * as Defs from "../../packages/lexicon/src/defs.ts";
import { Identity } from "../../packages/mailbox-client/src/index.ts";
import { MeasureError, testDid } from "./model.ts";

export const Inputs = Schema.Struct({
  hosted: Identity,
  readers: Schema.Array(Identity),
  service: Identity,
});

export const outside = Effect.fn("Measure.outside")(function* outside(
  file: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(path.resolve(import.meta.dirname, "../.."));
  const canonical = yield* fs.realPath(file);

  if (canonical === root || canonical.startsWith(`${root}/`)) {
    return yield* new MeasureError({
      reason: "Measurement files must remain outside the repository",
    });
  }

  return canonical;
});

const key = Effect.gen(function* key() {
  const pair = yield* Effect.tryPromise({
    catch: () => new MeasureError({ reason: "Test key generation failed" }),
    try: crypto.subtle.generateKey.bind(
      crypto.subtle,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    ),
  });

  if (!("privateKey" in pair)) {
    return yield* new MeasureError({ reason: "Expected a test key pair" });
  }

  const jwk = yield* Effect.tryPromise({
    catch: () => new MeasureError({ reason: "Test key export failed" }),
    try: crypto.subtle.exportKey.bind(crypto.subtle, "jwk", pair.privateKey),
  });

  return yield* Schema.decodeUnknownEffect(Identity.fields.signing)(jwk).pipe(
    Effect.mapError(
      () => new MeasureError({ reason: "Invalid generated test key" })
    )
  );
});

export const makeIdentity = Effect.fn("Measure.makeIdentity")(
  function* makeIdentity(did: string) {
    return { agreement: yield* key, did, signing: yield* key };
  }
);

const publicKey = (privateKey: typeof Identity.Type.signing) => ({
  crv: privateKey.crv,
  kty: privateKey.kty,
  x: privateKey.x,
  y: privateKey.y,
});

export const document = (identity: typeof Identity.Type) => ({
  authentication: [`${identity.did}#signing`],
  id: identity.did,
  keyAgreement: [`${identity.did}#agreement`],
  verificationMethod: [
    {
      controller: identity.did,
      id: `${identity.did}#signing`,
      publicKeyJwk: publicKey(identity.signing),
    },
    {
      controller: identity.did,
      id: `${identity.did}#agreement`,
      publicKeyJwk: publicKey(identity.agreement),
    },
  ],
});

export const generate = Effect.fn("Measure.generate")(function* generate(
  directory: string,
  count: number
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!Number.isSafeInteger(count) || count < 2 || count > 1000) {
    return yield* new MeasureError({
      reason: "Choose 2..1000 reader identities",
    });
  }

  const target = path.join(
    yield* outside(path.dirname(path.resolve(directory))),
    path.basename(directory)
  );

  const random = yield* Crypto.Crypto;
  const run = yield* random.randomUUIDv4();
  const did = (name: string) => `did:web:cfpreview-${run}-${name}.test.invalid`;

  const inputs = {
    hosted: yield* makeIdentity(did("hosted")),
    readers: yield* Effect.forEach(Array.from({ length: count }), (_, index) =>
      makeIdentity(did(`reader-${index}`))
    ),
    service: yield* makeIdentity(did("service")),
  };

  yield* fs.makeDirectory(target, { mode: 0o700 });

  const write = (name: string, value: Schema.Json) =>
    fs.writeFileString(
      path.join(target, name),
      `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );

  yield* write("inputs.json", inputs);
  yield* write("hosted.json", inputs.hosted);
  yield* write(
    "documents.json",
    [inputs.hosted, inputs.service, ...inputs.readers].map(document)
  );

  return target;
});

export const readInputs = Effect.fn("Measure.readInputs")(function* readInputs(
  directory: string,
  documentsFile: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inputFile = yield* outside(path.join(directory, "inputs.json"));
  const stat = yield* fs.stat(inputFile);

  if (stat.type !== "File" || stat.mode % 0o1000 !== 0o600) {
    return yield* new MeasureError({
      reason: "Inputs require a mode-600 regular file",
    });
  }

  const inputs = yield* Schema.decodeEffect(Schema.fromJsonString(Inputs))(
    yield* fs.readFileString(inputFile)
  ).pipe(
    Effect.mapError(
      () => new MeasureError({ reason: "Invalid private test inputs" })
    )
  );

  const documents = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Array(Defs.DidDocument))
  )(yield* fs.readFileString(yield* outside(documentsFile))).pipe(
    Effect.mapError(
      () => new MeasureError({ reason: "Invalid test documents" })
    )
  );

  const identities = [inputs.hosted, inputs.service, ...inputs.readers];
  const dids = identities.map((identity) => identity.did);

  if (
    inputs.readers.length < 2 ||
    dids.some((did) => !testDid(did)) ||
    new Set(dids).size !== dids.length ||
    documents.length !== dids.length ||
    documents.some((doc) => !testDid(doc.id)) ||
    identities.some(
      (identity) =>
        JSON.stringify(document(identity)) !==
        JSON.stringify(documents.find((doc) => doc.id === identity.did))
    )
  ) {
    return yield* new MeasureError({
      reason:
        "Only fresh matching cfpreview test identities and documents are accepted",
    });
  }

  return { documents, inputs };
});
