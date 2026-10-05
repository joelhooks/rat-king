// @effect-diagnostics nodeBuiltinImport:off -- Private fixture files belong outside the repository.
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy filesystem adapters. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";

import { CliError, Identity, readIdentity } from "../cli/identity.ts";
import { provision } from "../cli/provision.ts";
import { Documents } from "../src/auth.ts";

export const SuiteIdentities = Schema.Struct({
  agent: Schema.optionalKey(Identity),
  documents: Documents,
  recipient: Identity,
  sender: Identity,
});

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () =>
      new CliError({ reason: "Suite identity file operation failed" }),
    try: run,
  });

// oxlint-disable-next-line typescript/strict-void-return -- Node promisify consumes the callback overload.
const execute = promisify(execFile);

const outsideRepository = Effect.fn("Suite.outsideRepository")(
  function* outsideRepository(file: string) {
    const root = yield* io(() =>
      realpath(path.resolve(import.meta.dirname, "../../.."))
    );

    const parent = yield* io(() => realpath(path.dirname(path.resolve(file))));
    const relative = path.relative(root, parent);

    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    ) {
      return yield* new CliError({
        reason: "Suite outputs must be outside the repository",
      });
    }

    return path.join(parent, path.basename(file));
  }
);

export const generateIdentities = Effect.fn("Suite.generateIdentities")(
  function* generateIdentities(input: {
    identities: string;
    documents: string;
    hostedAgent?: boolean;
  }) {
    const privateFile = yield* outsideRepository(input.identities);
    const publicFile = yield* outsideRepository(input.documents);

    if (privateFile === publicFile) {
      return yield* new CliError({
        reason: "Private and public outputs must differ",
      });
    }

    const home = yield* Effect.acquireRelease(
      io(() => mkdtemp(path.join(tmpdir(), "rat-king-suite-keys-"))),
      (owned) => io(() => execute("trash", [owned])).pipe(Effect.orDie)
    );

    const run = randomUUID();
    const documents: (typeof Documents.Type)[number][] = [];

    for (const label of input.hostedAgent === true
      ? ["sender", "recipient", "agent"]
      : ["sender", "recipient"]) {
      const document = yield* provision(
        home,
        label,
        `did:web:${label}-${run}.example.invalid`
      );

      if (document === undefined) {
        return yield* new CliError({
          reason: "Missing provisioned public document",
        });
      }

      documents.push(document);
    }

    let identities: typeof SuiteIdentities.Type = {
      documents,
      recipient: yield* readIdentity(home, "recipient"),
      sender: yield* readIdentity(home, "sender"),
    };

    if (input.hostedAgent === true) {
      identities = { ...identities, agent: yield* readIdentity(home, "agent") };
    }

    const decoded =
      yield* Schema.decodeUnknownEffect(SuiteIdentities)(identities);

    yield* io(() =>
      writeFile(privateFile, JSON.stringify(decoded), {
        flag: "wx",
        mode: 0o600,
      })
    );
    yield* io(() =>
      writeFile(publicFile, JSON.stringify(documents), {
        flag: "wx",
        mode: 0o600,
      })
    );

    return decoded;
  }
);

export const readSuiteIdentities = Effect.fn("Suite.readIdentities")(
  function* readSuiteIdentities(file: string) {
    const info = yield* io(() => lstat(file));

    if (!info.isFile() || info.mode % 512 !== 0o600) {
      return yield* new CliError({
        reason: "Suite identities must be a regular mode-600 file",
      });
    }

    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(SuiteIdentities)
    )(yield* io(() => readFile(file, "utf-8"))).pipe(
      Effect.mapError(
        () => new CliError({ reason: "Invalid suite identities file" })
      )
    );
  }
);

if (
  process.argv[1] !== undefined &&
  process.argv[1] !== "" &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const [identities, documents] = process.argv.slice(2);

  if (
    identities === undefined ||
    identities === "" ||
    documents === undefined ||
    documents === ""
  ) {
    process.stderr.write(
      "Usage: node apps/mailbox/test/suite-identities.ts <private-file> <public-documents-file>\n"
    );
    process.exitCode = 1;
  } else {
    await Effect.runPromise(
      generateIdentities({ documents, identities }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.scoped,
        Effect.catchCause(() =>
          Effect.sync(() => {
            process.stderr.write(
              "Identity generation failed; use new paths outside the repository with existing parent directories.\n"
            );
            process.exitCode = 1;
          })
        )
      )
    );
  }
}
