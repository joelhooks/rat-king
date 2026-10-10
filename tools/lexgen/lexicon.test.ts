import { jsonToLex, Lexicons, parseLexiconDoc } from "@atproto/lexicon";
import type { LexiconDoc } from "@atproto/lexicon";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as Profile from "../../packages/lexicon/src/agent.profile.ts";
import {
  clientLayer,
  MailboxClient,
} from "../../packages/lexicon/src/mailbox-client.ts";
import * as List from "../../packages/lexicon/src/mailbox.list.ts";
import * as Send from "../../packages/lexicon/src/mailbox.send.ts";
import * as Query from "../../packages/lexicon/src/query.ts";
import * as Lease from "../../packages/lexicon/src/runtime.lease.ts";
import * as Runtime from "../../packages/lexicon/src/runtime.ts";
import { Transport } from "../../packages/lexicon/src/transport.ts";
import type { Response } from "../../packages/lexicon/src/transport.ts";
import { XrpcFailure } from "../../packages/lexicon/src/xrpc-failure.ts";
import { generate, GenerationError } from "./generate.ts";

const root = new URL("../../", import.meta.url).pathname;

const fixture = Effect.fn("test.fixture")(function* fixture(name: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
    yield* fs.readFileString(`${root}lexicons/fixtures/v0/${name}`)
  );
});

const documents = ["runtime/lease", "defs", "mailbox/list"];

const official = Effect.fn("test.official")(function* official() {
  const fs = yield* FileSystem.FileSystem;
  const docs: LexiconDoc[] = [];

  for (const name of documents) {
    docs.push(
      parseLexiconDoc(
        JSON.parse(
          yield* fs.readFileString(
            `${root}lexicons/sh/mschf/ratking/${name}.json`
          )
        )
      )
    );
  }

  return new Lexicons(docs);
});

it.effect(
  "rejects malformed known and untagged union variants, not just unrecognized types",
  () =>
    Effect.gen(function* strictVariants() {
      const validators = yield* official();

      const bad = {
        events: [{ $type: "sh.mschf.ratking.defs#messageEvent", seq: 1 }],
        throughSeq: 1,
      };

      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(List.Output)(bad).pipe(
            Effect.result
          )
        )
      ).toBe(true);
      expect(() =>
        validators.assertValidXrpcOutput(List.Method.nsid, jsonToLex(bad))
      ).toThrow();
      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(List.Output)({
            events: [{ seq: 1 }],
            throughSeq: 1,
          }).pipe(Effect.result)
        )
      ).toBe(true);
      const raw = yield* fixture("lease.object.json");
      const decoded = yield* Schema.decodeUnknownEffect(Lease.Main)(raw);
      const encoded = yield* Schema.encodeEffect(Lease.Main)(decoded);

      const malformed = {
        ...encoded,
        harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: 123 },
      };

      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Lease.Main)(malformed).pipe(
            Effect.result
          )
        )
      ).toBe(true);
      expect(
        validators.validate(
          "sh.mschf.ratking.runtime.lease",
          jsonToLex(malformed)
        ).success
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "retains unknown variants and nested extra fields including bytes and links",
  () =>
    Effect.gen(function* lossless() {
      const profile = yield* Schema.decodeUnknownEffect(Profile.Main)(
        yield* fixture("profile.record.json")
      );

      const unknown = {
        events: [
          {
            $type: "sh.mschf.ratking.defs#futureEvent",
            nested: {
              bytes: new Uint8Array([1, 2, 3]),
              cid: yield* Schema.decodeUnknownEffect(Runtime.Cid)(
                profile.icon?.ref
              ),
              marker: "retained",
            },
            seq: 3,
          },
        ],
        throughSeq: 3,
      };

      const wire = yield* Schema.encodeEffect(Schema.toType(List.Output))(
        unknown
      );

      const encoded = yield* Schema.encodeEffect(List.Output)(wire);
      const decoded = yield* Schema.decodeUnknownEffect(List.Output)(encoded);
      expect(decoded).toEqual(unknown);

      const input = yield* Schema.decodeUnknownEffect(Send.Input)(
        yield* fixture("send.input.json")
      );

      const extra = {
        ...input,
        envelope: {
          ...input.envelope,
          aad: { ...input.envelope.aad, futureKey: "retained" },
          future: {
            bytes: new Uint8Array([4, 5]),
            spelling: "2026-10-04T00:00:00+00:00",
          },
        },
      };

      const roundTrip = yield* Schema.decodeUnknownEffect(Send.Input)(
        yield* Schema.encodeEffect(Send.Input)(extra)
      );

      expect(roundTrip).toEqual(extra);
      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Runtime.DataMap)({
            bad: { $bytes: "%%%" },
          }).pipe(Effect.result)
        )
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "rejects floats and unsafe integers in declared and unknown fields",
  () =>
    Effect.gen(function* integers() {
      const input = yield* Schema.decodeUnknownEffect(Send.Input)(
        yield* fixture("send.input.json")
      );

      for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const raw = yield* Schema.encodeEffect(Send.Input)(input);
        expect(
          Result.isFailure(
            yield* Schema.decodeUnknownEffect(Send.Input)({
              ...raw,
              envelope: { ...raw.envelope, version: value },
            }).pipe(Effect.result)
          )
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* Schema.decodeUnknownEffect(Runtime.DataMap)({
              future: { number: value },
            }).pipe(Effect.result)
          )
        ).toBe(true);
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "preserves HTTP status, unknown error names and non-JSON failure evidence",
  () =>
    Effect.gen(function* transportErrors() {
      const input = yield* Schema.decodeUnknownEffect(Send.Input)(
        yield* fixture("send.input.json")
      );

      for (const response of [
        {
          body: {
            error: "FutureError",
            future: { retained: true },
            message: "reason",
          },
          kind: "json",
          status: 429,
        },
        { body: "not JSON", kind: "text", status: 503 },
      ] satisfies readonly Response[]) {
        const transport = Layer.succeed(
          Transport,
          Transport.of({ request: () => Effect.succeed(response) })
        );

        const result = yield* Effect.gen(function* invoke() {
          const client = yield* MailboxClient;

          return yield* client.send(input);
        }).pipe(
          Effect.provide(clientLayer.pipe(Layer.provide(transport))),
          Effect.result
        );

        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(Schema.is(XrpcFailure)(result.failure)).toBe(true);

          if (Schema.is(XrpcFailure)(result.failure)) {
            expect(result.failure.status).toBe(response.status);
            expect(result.failure.response).toEqual(response.body);
          }
        }
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "detects generated drift in a temporary copy without editing the checkout",
  () =>
    Effect.gen(function* drift() {
      const fs = yield* FileSystem.FileSystem;
      const copy = yield* fs.makeTempDirectoryScoped();

      for (const name of ["lexicons", "tools/lexgen", "packages/lexicon"]) {
        yield* fs.makeDirectory(`${copy}/${name}`, { recursive: true });
        yield* fs.copy(`${root}${name}`, `${copy}/${name}`);
      }

      yield* fs.copy(`${root}package.json`, `${copy}/package.json`);
      yield* generate({ root: copy, write: false });
      const target = `${copy}/packages/lexicon/src/defs.ts`;
      yield* fs.writeFileString(
        target,
        `${yield* fs.readFileString(target)}\n`
      );

      const result = yield* generate({ root: copy, write: false }).pipe(
        Effect.result
      );

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          `${root}tools/lexgen/cli.ts`,
          "--check",
          "--root",
          copy,
        ])
      );

      const observed = yield* Effect.all(
        {
          code: child.exitCode,
          errors: Stream.runCollect(child.stderr),
          output: Stream.runCollect(child.stdout),
        },
        { concurrency: "unbounded" }
      );

      expect(Number(observed.code)).not.toBe(0);
      expect(Result.isFailure(result)).toBe(true);

      if (
        Result.isFailure(result) &&
        Schema.is(GenerationError)(result.failure)
      ) {
        expect(result.failure.reason).toContain("Generation drift");
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "encodes and decodes query primitives and repeated keys without applying hidden defaults",
  () =>
    Effect.gen(function* query() {
      const params = yield* Schema.decodeUnknownEffect(List.Params)(
        yield* fixture("list.params.json")
      );

      const pairs = yield* List.encodeParams(params);
      expect(yield* List.decodeParams(pairs)).toEqual(params);

      const withoutDefault = yield* List.decodeParams([
        ["recipientDid", params.recipientDid],
      ]);

      expect(withoutDefault.limit).toBeUndefined();
      expect(
        Result.isFailure(
          yield* List.decodeParams([
            ["recipientDid", params.recipientDid],
            ["limit", "101"],
          ]).pipe(Effect.result)
        )
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* List.decodeParams([
            ["recipientDid", params.recipientDid],
            ["limit", "1.5"],
          ]).pipe(Effect.result)
        )
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* List.decodeParams([
            ["recipientDid", params.recipientDid],
            ["limit", "1"],
            ["limit", "2"],
          ]).pipe(Effect.result)
        )
      ).toBe(true);
      expect(
        Query.entries(
          Query.parameters([
            ["items", "a"],
            ["items", "b"],
          ])
        )
      ).toEqual([
        ["items", "a"],
        ["items", "b"],
      ]);
      expect(yield* Schema.decodeEffect(Query.BooleanFromQuery)("true")).toBe(
        true
      );
      expect(yield* Schema.encodeEffect(Query.BooleanFromQuery)(false)).toBe(
        "false"
      );
    }).pipe(Effect.provide(NodeServices.layer))
);
