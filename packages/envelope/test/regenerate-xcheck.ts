import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import * as Defs from "@rat-king/lexicon/defs";
import { Arbitrary, Effect, Exit, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { canonical, open, seal, signingBytes } from "../src/envelope.ts";
import {
  Fixture,
  importKeys,
  payloadArbitrary,
  requestFor,
} from "./xcheck-support.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));

const directory = fileURLToPath(new URL("vectors/xcheck/", import.meta.url));

const go = Effect.fn("Xcheck.go")(function* go(mode: string, input: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const handle = yield* spawner.spawn(
    ChildProcess.make("go", ["run", ".", mode], {
      cwd: `${root}/tools/envelope-xcheck`,
      stdin: Stream.succeed(new TextEncoder().encode(input)),
    })
  );

  const result = yield* Effect.all(
    {
      code: handle.exitCode,
      stderr: Stream.runCollect(handle.stderr),
      stdout: Stream.runCollect(handle.stdout),
    },
    { concurrency: "unbounded" }
  );

  if (result.code !== 0) {
    throw new Error(
      `Go ${mode} failed: ${Buffer.concat(result.stderr).toString("utf-8")}`
    );
  }

  return Buffer.concat(result.stdout).toString("utf-8");
}, Effect.scoped);

const Row = Schema.Struct({
  accepted: Schema.Boolean,
  envelope: Defs.EncryptedEnvelope,
  payload: Defs.SigningPayload,
});

await Effect.runPromise(
  Effect.gen(function* regenerate() {
    const fs = yield* FileSystem.FileSystem;

    const samples = yield* Arbitrary.sampleEffect(payloadArbitrary, {
      count: 4000,
      seed: 9180,
    });

    const unique = new Map(
      samples.map((sample) => [
        Buffer.from(
          signingBytes(Schema.decodeSync(Defs.SigningPayload)(sample))
        ).toString("hex"),
        sample,
      ])
    );

    if (unique.size !== 36) {
      throw new Error(
        `Expected all 36 finite Schema-derived payloads, got ${unique.size}`
      );
    }

    const output = yield* go("generate", JSON.stringify([...unique.values()]));

    const fixture = yield* Schema.decodeEffect(Schema.fromJsonString(Fixture))(
      output
    );

    const keys = yield* importKeys(fixture);
    const rows = [];

    for (const vector of fixture.vectors) {
      const opened = yield* open(requestFor(vector.envelope, keys));

      if (
        !Buffer.from(canonical(opened)).equals(
          Buffer.from(canonical(vector.payload))
        )
      ) {
        throw new Error("Go -> TS payload disagreement");
      }

      const envelope = yield* seal({
        payload: vector.payload,
        recipientKey: keys.recipientPublic,
        recipientKeyId: vector.payload.aad.recipientKeyId,
        signingKey: keys.senderPrivate,
        signingKeyId: `${vector.payload.aad.senderDid}#atproto`,
      });

      rows.push({ accepted: true, envelope, payload: vector.payload });

      for (const rejected of vector.reject) {
        const exit = yield* open(requestFor(rejected.envelope, keys)).pipe(
          Effect.exit
        );

        if (!Exit.isFailure(exit)) {
          throw new Error(`Go/TS rejection disagreement: ${rejected.name}`);
        }

        rows.push({
          accepted: false,
          envelope: rejected.envelope,
          payload: vector.payload,
        });
      }

      const ciphertext = Uint8Array.from(envelope.ciphertext);
      ciphertext[0] = (ciphertext[0] ?? 0) === 0 ? 1 : 0;

      const mutations = [
        { ...envelope, ciphertext },
        { ...envelope, aad: { ...envelope.aad, future: "changed" } },
        { ...envelope, suite: { ...envelope.suite, aeadId: 2 } },
        { ...envelope, enc: new Uint8Array([4]) },
      ];

      for (const altered of mutations) {
        const exit = yield* open(requestFor(altered, keys)).pipe(Effect.exit);

        if (!Exit.isFailure(exit)) {
          throw new Error("TS accepted a malformed seal mutation");
        }

        rows.push({
          accepted: false,
          envelope: altered,
          payload: vector.payload,
        });
      }
    }

    const input = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Row))
    )(rows);

    const receipt = yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          verified: Schema.Int,
        })
      )
    )(yield* go("verify", input));

    if (receipt.verified !== rows.length) {
      throw new Error("Go verify receipt count disagreement");
    }

    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(`${directory}/go.json`, output);
    yield* fs.writeFileString(`${directory}/ts.json`, `${input}\n`);
    yield* fs.writeFileString(
      `${directory}/receipt.json`,
      `${JSON.stringify(
        {
          goVerified: receipt.verified,
          payloads: unique.size,
          seed: 9180,
          suite: [16, 1, 1],
        },
        null,
        2
      )}\n`
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const formatCode = yield* spawner.exitCode(
      ChildProcess.make("pnpm", ["exec", "oxfmt", directory], {
        cwd: root,
        stderr: "inherit",
        stdout: "inherit",
      })
    );

    if (formatCode !== 0) {
      throw new Error("Vector formatting failed");
    }

    yield* Effect.log(
      `Cross-check passed: ${unique.size} payloads, ${receipt.verified} Go verify cases`
    );
  }).pipe(Effect.provide(NodeServices.layer))
);
