// @effect-diagnostics nodeBuiltinImport:off -- Tests verify immutable contract byte digests.
import { createHash } from "node:crypto";

import {
  jsonToLex,
  Lexicons,
  lexToJson,
  parseLexiconDoc,
} from "@atproto/lexicon";
import type { LexiconDoc } from "@atproto/lexicon";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as PutDidDocument from "../../packages/lexicon/src/admin.putDidDocument.ts";
import * as Profile from "../../packages/lexicon/src/agent.profile.ts";
import * as Defs from "../../packages/lexicon/src/defs.ts";
import * as Theme from "../../packages/lexicon/src/desk.theme.ts";
import {
  clientLayer,
  MailboxClient,
} from "../../packages/lexicon/src/mailbox-client.ts";
import { MailboxHandlers } from "../../packages/lexicon/src/mailbox-handlers.ts";
import {
  MailboxServer,
  serverLayer,
} from "../../packages/lexicon/src/mailbox-server.ts";
import * as Ack from "../../packages/lexicon/src/mailbox.ack.ts";
import * as Deliver from "../../packages/lexicon/src/mailbox.deliver.ts";
import * as List from "../../packages/lexicon/src/mailbox.list.ts";
import * as Send from "../../packages/lexicon/src/mailbox.send.ts";
import * as Subscribe from "../../packages/lexicon/src/mailbox.subscribe.ts";
import * as Query from "../../packages/lexicon/src/query.ts";
import * as AcquireLease from "../../packages/lexicon/src/runtime.acquireLease.ts";
import * as Lease from "../../packages/lexicon/src/runtime.lease.ts";
import * as ReleaseLease from "../../packages/lexicon/src/runtime.releaseLease.ts";
import * as RenewLease from "../../packages/lexicon/src/runtime.renewLease.ts";
import * as ResolveLease from "../../packages/lexicon/src/runtime.resolveLease.ts";
import * as Runtime from "../../packages/lexicon/src/runtime.ts";
import { TransportFailure } from "../../packages/lexicon/src/transport-failure.ts";
import { Transport } from "../../packages/lexicon/src/transport.ts";
import type { Response } from "../../packages/lexicon/src/transport.ts";
import { XrpcFailure } from "../../packages/lexicon/src/xrpc-failure.ts";
import { generate, GenerationError, walk } from "./generate.ts";

const root = new URL("../../", import.meta.url).pathname;

const fixture = Effect.fn("test.fixture")(function* fixture(name: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
    yield* fs.readFileString(`${root}lexicons/fixtures/v0/${name}`)
  );
});

const documents = [
  "runtime/acquireLease",
  "runtime/renewLease",
  "runtime/releaseLease",
  "runtime/resolveLease",
  "mailbox/deliver",
  "admin/putDidDocument",
  "mailbox/subscribe",
  "agent/profile",
  "defs",
  "desk/theme",
  "mailbox/ack",
  "mailbox/list",
  "mailbox/send",
  "runtime/lease",
];

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

  expect(docs).toHaveLength(14);

  return new Lexicons(docs);
});

interface Fixture {
  readonly file: string;
  readonly kind:
    | "record"
    | "input"
    | "output"
    | "params"
    | "object"
    | "message";
  readonly nsid: string;
  readonly schema: Schema.Codec<Runtime.LexValue, Runtime.LexJson>;
}

const fixtures: readonly Fixture[] = [
  {
    file: "acquire-lease.input.json",
    kind: "input",
    nsid: "sh.mschf.ratking.runtime.acquireLease",
    schema: AcquireLease.Input,
  },
  {
    file: "acquire-lease.output.json",
    kind: "output",
    nsid: "sh.mschf.ratking.runtime.acquireLease",
    schema: AcquireLease.Output,
  },
  {
    file: "renew-lease.input.json",
    kind: "input",
    nsid: "sh.mschf.ratking.runtime.renewLease",
    schema: RenewLease.Input,
  },
  {
    file: "renew-lease.output.json",
    kind: "output",
    nsid: "sh.mschf.ratking.runtime.renewLease",
    schema: RenewLease.Output,
  },
  {
    file: "release-lease.input.json",
    kind: "input",
    nsid: "sh.mschf.ratking.runtime.releaseLease",
    schema: ReleaseLease.Input,
  },
  {
    file: "resolve-lease.params.json",
    kind: "params",
    nsid: "sh.mschf.ratking.runtime.resolveLease",
    schema: ResolveLease.Params,
  },
  {
    file: "resolve-lease.output.json",
    kind: "output",
    nsid: "sh.mschf.ratking.runtime.resolveLease",
    schema: ResolveLease.Output,
  },
  {
    file: "deliver.input.json",
    kind: "input",
    nsid: "sh.mschf.ratking.mailbox.deliver",
    schema: Deliver.Input,
  },
  {
    file: "deliver.output.json",
    kind: "output",
    nsid: "sh.mschf.ratking.mailbox.deliver",
    schema: Deliver.Output,
  },
  {
    file: "put-did-document.input.json",
    kind: "input",
    nsid: "sh.mschf.ratking.admin.putDidDocument",
    schema: PutDidDocument.Input,
  },
  {
    file: "put-did-document.output.json",
    kind: "output",
    nsid: "sh.mschf.ratking.admin.putDidDocument",
    schema: PutDidDocument.Output,
  },
  {
    file: "subscribe.params.json",
    kind: "params",
    nsid: "sh.mschf.ratking.mailbox.subscribe",
    schema: Subscribe.Params,
  },
  {
    file: "subscribe-notice.object.json",
    kind: "message",
    nsid: "sh.mschf.ratking.mailbox.subscribe",
    schema: Subscribe.Message,
  },
  {
    file: "subscribe-auth.object.json",
    kind: "object",
    nsid: "sh.mschf.ratking.mailbox.subscribe#auth",
    schema: Subscribe.Auth,
  },
  {
    file: "did-document.object.json",
    kind: "object",
    nsid: "sh.mschf.ratking.defs#didDocument",
    schema: Defs.DidDocument,
  },
  {
    file: "urgent-signing-payload.object.json",
    kind: "object",
    nsid: "sh.mschf.ratking.defs#signingPayload",
    schema: Defs.SigningPayload,
  },
  {
    file: "fenced-send.input.json",
    kind: "input",
    nsid: "sh.mschf.ratking.mailbox.send",
    schema: Send.Input,
  },
  {
    file: "profile.record.json",
    kind: "record",
    nsid: "sh.mschf.ratking.agent.profile",
    schema: Profile.Main,
  },
  {
    file: "theme.record.json",
    kind: "record",
    nsid: "sh.mschf.ratking.desk.theme",
    schema: Theme.Main,
  },
  {
    file: "send.input.json",
    kind: "input",
    nsid: "sh.mschf.ratking.mailbox.send",
    schema: Send.Input,
  },
  {
    file: "ack.input.json",
    kind: "input",
    nsid: "sh.mschf.ratking.mailbox.ack",
    schema: Ack.Input,
  },
  {
    file: "lease.object.json",
    kind: "object",
    nsid: "sh.mschf.ratking.runtime.lease",
    schema: Lease.Main,
  },
  {
    file: "list.params.json",
    kind: "params",
    nsid: "sh.mschf.ratking.mailbox.list",
    schema: List.Params,
  },
  {
    file: "send.output.json",
    kind: "output",
    nsid: "sh.mschf.ratking.mailbox.send",
    schema: Send.Output,
  },
  {
    file: "ack.output.json",
    kind: "output",
    nsid: "sh.mschf.ratking.mailbox.ack",
    schema: Ack.Output,
  },
  {
    file: "list.output.json",
    kind: "output",
    nsid: "sh.mschf.ratking.mailbox.list",
    schema: List.Output,
  },
  {
    file: "signed-message.object.json",
    kind: "object",
    nsid: "sh.mschf.ratking.defs#signedMessage",
    schema: Defs.SignedMessage,
  },
  {
    file: "signing-payload.object.json",
    kind: "object",
    nsid: "sh.mschf.ratking.defs#signingPayload",
    schema: Defs.SigningPayload,
  },
];

const validateOfficial = (
  validators: Lexicons,
  entry: Fixture,
  raw: Runtime.LexJson
) => {
  const value = jsonToLex(raw);

  switch (entry.kind) {
    case "record": {
      return validators.assertValidRecord(entry.nsid, value);
    }

    case "input": {
      return validators.assertValidXrpcInput(entry.nsid, value);
    }

    case "output": {
      return validators.assertValidXrpcOutput(entry.nsid, value);
    }

    case "params": {
      return validators.assertValidXrpcParams(entry.nsid, value);
    }

    case "message": {
      return validators.assertValidXrpcMessage(entry.nsid, value);
    }

    case "object": {
      const result = validators.validate(entry.nsid, value);

      if (!result.success) {
        throw result.error;
      }

      return result.value;
    }

    default: {
      throw new Error("Unknown fixture kind");
    }
  }
};

it.effect("agrees with the official validator on all v0 fixtures", () =>
  Effect.gen(function* parity() {
    const validators = yield* official();
    expect(fixtures).toHaveLength(28);
    const fs = yield* FileSystem.FileSystem;
    expect(
      (yield* fs.readDirectory(`${root}lexicons/fixtures/v0`)).toSorted()
    ).toEqual(fixtures.map((entry) => entry.file).toSorted());

    for (const entry of fixtures) {
      const raw = yield* fixture(entry.file);
      const decoded = yield* Schema.decodeUnknownEffect(entry.schema)(raw);
      const encoded = yield* Schema.encodeEffect(entry.schema)(decoded);
      const validated = validateOfficial(validators, entry, raw);
      expect(lexToJson(jsonToLex(encoded))).toEqual(lexToJson(validated));
      expect(lexToJson(jsonToLex(encoded))).toEqual(lexToJson(jsonToLex(raw)));
    }
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "rejects malformed known and untagged union variants, not just unrecognized types",
  () =>
    Effect.gen(function* strictVariants() {
      const validators = yield* official();

      const entry = fixtures.find(
        (candidate) => candidate.file === "list.output.json"
      );

      expect(entry).toBeDefined();

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

it.effect("keeps delivery states open but known helpers strict", () =>
  Effect.gen(function* knownValues() {
    const future = yield* Schema.decodeUnknownEffect(Defs.DeliveryState)(
      "future-state"
    );

    expect(Defs.isDeliveryStateKnown(future)).toBe(false);
    expect(Defs.isDeliveryStateKnown("acked")).toBe(true);
  })
);

it.effect(
  "round-trips send through generated client, in-memory transport and server route table",
  () =>
    Effect.gen(function* roundTrip() {
      const input = yield* Schema.decodeUnknownEffect(Send.Input)(
        yield* fixture("send.input.json")
      );

      const output = yield* Schema.decodeUnknownEffect(Send.Output)(
        yield* fixture("send.output.json")
      );

      const handlers = Layer.succeed(
        MailboxHandlers,
        MailboxHandlers.of({
          ack: () =>
            Effect.fail(
              new XrpcFailure({
                error: "UnsupportedTest",
                response: {},
                status: 400,
              })
            ),
          acquireLease: () =>
            Effect.fail(
              new XrpcFailure({
                error: "UnsupportedTest",
                response: {},
                status: 400,
              })
            ),
          deliver: () =>
            Effect.fail(
              new XrpcFailure({
                error: "UnsupportedTest",
                response: {},
                status: 400,
              })
            ),
          list: () =>
            Effect.fail(
              new XrpcFailure({
                error: "UnsupportedTest",
                response: {},
                status: 400,
              })
            ),
          putDidDocument: () =>
            Effect.fail(
              new XrpcFailure({
                error: "UnsupportedTest",
                response: {},
                status: 400,
              })
            ),
          releaseLease: () =>
            Effect.fail(
              new XrpcFailure({
                error: "UnsupportedTest",
                response: {},
                status: 400,
              })
            ),
          renewLease: () =>
            Effect.fail(
              new XrpcFailure({
                error: "UnsupportedTest",
                response: {},
                status: 400,
              })
            ),
          resolveLease: () =>
            Effect.fail(
              new XrpcFailure({
                error: "UnsupportedTest",
                response: {},
                status: 400,
              })
            ),
          send: Effect.fn("test.send")((received) =>
            Effect.sync(() => {
              expect(received).toEqual(input);

              return output;
            })
          ),
        })
      );

      const transport = Layer.effect(
        Transport,
        Effect.gen(function* transport() {
          const server = yield* MailboxServer;
          expect(server.routes.size).toBe(9);

          return Transport.of({
            request: Effect.fn("test.request")(function* request(value) {
              const route = server.routes.get(`/xrpc/${value.nsid}`);

              if (route === undefined) {
                return yield* new TransportFailure({
                  cause: null,
                  reason: "Unknown route",
                });
              }

              return yield* route.handle(value).pipe(
                Effect.mapError(
                  (cause) =>
                    new TransportFailure({
                      cause,
                      reason: "Schema rejected request",
                    })
                )
              );
            }),
          });
        })
      ).pipe(Layer.provide(serverLayer.pipe(Layer.provide(handlers))));

      const result = yield* Effect.gen(function* invoke() {
        const client = yield* MailboxClient;

        return yield* client.send(input);
      }).pipe(Effect.provide(clientLayer.pipe(Layer.provide(transport))));

      expect(result).toEqual(output);
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

const contractHashes = {
  "lexicons/fixtures/v0/ack.input.json":
    "5ae3c6912e14f90a8fe64c331133ce7d75c2925c1b4c2cacbe2c46bf9f26b1b6",
  "lexicons/fixtures/v0/ack.output.json":
    "d92f3c839ac585dfb6729e81f4f2ae283bb50c8a4187dff5b86ceac013747b31",
  "lexicons/fixtures/v0/lease.object.json":
    "316646b06ffe0cbe4a694b704c0a616606d6fe967aad8603de69adfc0fbc73db",
  "lexicons/fixtures/v0/list.output.json":
    "0a9d87da780445a8b9926bbd2ce5ae44451500cab2cb4e40707d6d23be003a61",
  "lexicons/fixtures/v0/list.params.json":
    "b5f928471a0852599db6eeb21b23d8f02797aacb3c019e8751178a20f635e9de",
  "lexicons/fixtures/v0/profile.record.json":
    "c3eb2252b5f64a6c61692f5dd069ca4ed0ef5221dc9391ff06d4fe0ad9019cdc",
  "lexicons/fixtures/v0/send.input.json":
    "6920c3ad59e6c0fb49a8d3d18dffeeddb80609e7314a5d2fd6ebdbef798f678b",
  "lexicons/fixtures/v0/send.output.json":
    "4e5ce9dde39a60317cd3653d887a752cb699628886e7fd3236490fa7daed62c1",
  "lexicons/fixtures/v0/signed-message.object.json":
    "b26017b44e5b0db42d530afe3e9d4717232f96a4b1b10dc873a399bf19920915",
  "lexicons/fixtures/v0/signing-payload.object.json":
    "c535b1ffbc3a1c327e862ff9dd0c193d0ae266e38d537106d11377f0e21beb4d",
  "lexicons/fixtures/v0/theme.record.json":
    "86c23ed981414bb971464a8c995c5c4abe8843a30de2eb54ebc0799b5064ecab",
  "lexicons/sh/mschf/ratking/agent/profile.json":
    "e1ade87b6464f51f79c7c32aa036827d8d9aebe930992feffeb0390c2f05c2a5",

  "lexicons/sh/mschf/ratking/desk/theme.json":
    "0e86b836c72db651ec5cb9c14e934a01c88fb795df2f602ff47e27dc4893f2e3",

  "lexicons/sh/mschf/ratking/mailbox/list.json":
    "48da50a617d1d98975634d7f989a88015508b76e845918c8349f77a9e8ae9b43",

  "lexicons/sh/mschf/ratking/runtime/lease.json":
    "e9d8d82566f241a9431c915c87377e1faa6ae7465e718d8d29f310c4e0d16798",
} as const;

it.effect(
  "pins original v0 fixtures and unchanged documents to their approved SHA-256 bytes",
  () =>
    Effect.gen(function* bytePins() {
      const fs = yield* FileSystem.FileSystem;

      const files = (yield* walk(`${root}lexicons`)).filter((file) =>
        file.endsWith(".json")
      );

      for (const file of Object.keys(contractHashes)) {
        expect(files).toContain(`${root}${file}`);
      }

      for (const [file, digest] of Object.entries(contractHashes)) {
        expect(
          createHash("sha256")
            .update(yield* fs.readFile(`${root}${file}`))
            .digest("hex")
        ).toBe(digest);
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
