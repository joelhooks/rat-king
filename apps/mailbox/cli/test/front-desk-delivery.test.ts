import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { plaintext } from "@rat-king/envelope/canonical";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import * as Send from "@rat-king/lexicon/mailbox.send";
import {
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
  Layer,
  Predicate,
  Result,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import {
  document,
  identity,
} from "../../../../packages/mailbox-client/test/identity.ts";
import { frontDeskCommand } from "../../../../stacks/nest/front-desk-command.ts";
import { staticResolver } from "../../src/auth.ts";
import { Caller } from "../../src/caller.ts";
import { leaseLayer } from "../../src/lease.ts";
import { mailboxHandlers } from "../../src/mailbox.ts";
import { MailboxStore } from "../../src/store.ts";
import { testStoreFor, unleasedSender } from "../../test/helpers.ts";

const signer = "fixture-signer";

const primaryDid = "did:web:primary.example.invalid";

const copyDid = "did:web:copy.example.invalid";

const senderDid = "did:web:relay.example.invalid";

const seed = Effect.gen(function* seed() {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();

  const sender = yield* identity(senderDid);
  const primary = yield* identity(primaryDid);
  const copy = yield* identity(copyDid);
  const peers = yield* Effect.forEach([primary, copy], document);

  const piConfig = `${dir}/pi.json`;
  const peerPath = `${dir}/peers.json`;

  yield* fs.writeFileString(`${dir}/${signer}`, JSON.stringify(sender), {
    mode: 0o600,
  });
  yield* fs.writeFileString(peerPath, JSON.stringify(peers));
  yield* fs.writeFileString(
    piConfig,
    JSON.stringify({
      didTemplate: "did:web:{agent}.example.invalid",
      documents: [peerPath],
      endpoint: "https://mailbox.example.invalid",
      reserved: { copy: { did: copyDid }, primary: { did: primaryDid } },
      serviceDid: "did:web:service.example.invalid",
      state: dir,
    })
  );

  return {
    dir,
    peers,
    provider: ConfigProvider.fromUnknown({
      CREDENTIALS_DIRECTORY: dir,
      RATKING_CONFIG: piConfig,
      RAT_KING_FRONT_DESK_CC: "copy",
      RAT_KING_FRONT_DESK_SIGNER: signer,
      RAT_KING_FRONT_DESK_TO: "primary",
      RAT_KING_SECRET_SOURCE: "systemd",
    }),
  };
});

const Path = Schema.Literals(["copy-refused", "primary-reply-lost", "all-ok"]);

const fixtureMailbox = Effect.fn("Test.frontDeskMailbox")(
  function* fixtureMailbox(
    posted: Send.InputValue[],
    first: typeof Path.Type,
    peers: Effect.Success<typeof seed>["peers"]
  ) {
    const primary = yield* testStoreFor(primaryDid);
    const copy = yield* testStoreFor(copyDid);

    const policy = { operators: [], resolvers: [], staticDocuments: peers };

    const route = (db: typeof primary) =>
      mailboxHandlers(policy).pipe(
        Layer.provide([
          db.layer,
          leaseLayer.pipe(Layer.provide(db.layer)),
          Layer.succeed(Caller, { did: senderDid }),
          staticResolver(peers),
          unleasedSender,
        ])
      );

    const inbox = route(primary);
    const carbon = route(copy);

    const client = HttpClient.make((request) =>
      Effect.gen(function* respond() {
        expect(request.url).toContain(Send.Method.path);

        if (!Predicate.isTagged(request.body, "Uint8Array")) {
          return yield* Effect.die("Expected JSON body");
        }

        const input = yield* Schema.decodeEffect(
          Schema.fromJsonString(Send.Input)
        )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

        posted.push(input);

        const isCopy = input.envelope.aad.recipientDid === copyDid;

        if (first === "copy-refused" && isCopy && posted.length === 2) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "Conflict" }, { status: 409 })
          );
        }

        const receipt = yield* MailboxHandlers.use((mailbox) =>
          mailbox.send(input)
        ).pipe(
          Effect.provide(isCopy ? carbon : inbox),
          Effect.flatMap(Schema.encodeEffect(Send.Output)),
          Effect.orDie
        );

        return HttpClientResponse.fromWeb(
          request,
          first === "primary-reply-lost" && posted.length === 1
            ? Response.json({ error: "MailboxUnavailable" }, { status: 503 })
            : Response.json(receipt)
        );
      })
    );

    const admitted = (db: typeof primary) =>
      MailboxStore.use((store) =>
        store.transaction((tx) => tx.watermark())
      ).pipe(Effect.provide(db.layer));

    return {
      admitted: Effect.all({
        copy: admitted(copy),
        primary: admitted(primary),
      }),
      client,
    };
  }
);

it.effect.prop(
  "front desk journals the primary before copy, replays identical bytes after an uncertain receipt, and returns one stable receipt",
  [Schema.Boolean, Path],
  ([quiet, path]) =>
    Effect.gen(function* check() {
      const { peers, provider } = yield* seed;
      const posted: Send.InputValue[] = [];

      const { admitted, client } = yield* fixtureMailbox(posted, path, peers);

      const lines: string[] = [];

      const input = new TextEncoder().encode(
        JSON.stringify({
          body: "private fixture",
          id: "fixture",
          quiet,
          summary: "sample",
        })
      );

      const send = frontDeskCommand(["--stdin"]).pipe(
        Effect.provide([
          ConfigProvider.layer(provider),
          Stdio.layerTest({ stdin: Stream.succeed(input) }),
        ]),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(Console.Console, {
          ...console,
          log: (line: string) => {
            lines.push(line);
          },
        }),
        Effect.result
      );

      const first = yield* send;
      const retry = yield* send;
      const completed = yield* send;

      expect(Result.isSuccess(first)).toBe(path === "all-ok");
      expect(Result.isSuccess(retry)).toBe(true);
      expect(Result.isSuccess(completed)).toBe(true);
      expect(yield* admitted).toEqual({ copy: 1, primary: 1 });

      const receipt = JSON.stringify({
        messageId: posted[0]?.envelope.aad.messageId,
        ok: true,
      });

      expect(lines).toEqual(
        Array.from({ length: path === "all-ok" ? 3 : 2 }, () => receipt)
      );

      const primary = posted.filter(
        (entry) => entry.envelope.aad.recipientDid === primaryDid
      );

      const copies = posted.filter(
        (entry) => entry.envelope.aad.recipientDid === copyDid
      );

      expect(primary).toHaveLength(path === "primary-reply-lost" ? 2 : 1);
      expect(copies).toHaveLength(path === "copy-refused" ? 2 : 1);
      expect(primary.at(-1)).toEqual(primary[0]);
      expect(copies.at(-1)).toEqual(copies[0]);
      expect(posted.every((entry) => !plaintext(entry.envelope))).toBe(true);
      expect(primary[0]).toMatchObject({
        wakeReason: quiet ? "quiet" : "to",
        woke: !quiet,
      });
      expect(copies[0]).toMatchObject({ wakeReason: "cc", woke: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 } }
);

it.live(
  "concurrent invocations share one delivery; changed content and corrupt journal refuse",
  () =>
    Effect.gen(function* verify() {
      const { dir, peers, provider } = yield* seed;
      const posted: Send.InputValue[] = [];
      const receipts: string[] = [];

      const { admitted, client } = yield* fixtureMailbox(
        posted,
        "all-ok",
        peers
      );

      const send = (body: string) =>
        frontDeskCommand(["--stdin"]).pipe(
          Effect.provide([
            ConfigProvider.layer(provider),
            Stdio.layerTest({
              stdin: Stream.succeed(
                new TextEncoder().encode(
                  JSON.stringify({
                    body,
                    id: "same-id",
                    quiet: false,
                    summary: "fixture",
                  })
                )
              ),
            }),
          ]),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Console.Console, {
            ...console,
            log: (line: string) => {
              receipts.push(line);
            },
          })
        );

      yield* Effect.all([send("same body"), send("same body")], {
        concurrency: "unbounded",
      });

      expect(receipts).toHaveLength(2);
      expect(receipts[0]).toBe(receipts[1]);
      expect(posted).toHaveLength(2);
      expect(yield* admitted).toEqual({ copy: 1, primary: 1 });
      expect(yield* send("different body").pipe(Effect.isFailure)).toBe(true);

      const fs = yield* FileSystem.FileSystem;
      const journal = `${dir}/front-desk-send`;

      const entries = yield* fs.readDirectory(journal);
      const file = entries.find((entry) => entry.endsWith(".json"));

      if (file === undefined) {
        return yield* Effect.die("No journal entry");
      }

      yield* fs.writeFile(`${journal}/.journal-key`, new Uint8Array(32));
      expect(yield* send("same body").pipe(Effect.isFailure)).toBe(true);

      yield* fs.writeFileString(`${journal}/${file}`, "corrupt");
      expect(yield* send("same body").pipe(Effect.isFailure)).toBe(true);
      expect(posted).toHaveLength(2);

      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
