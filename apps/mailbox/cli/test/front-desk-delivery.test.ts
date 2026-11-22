import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { plaintext } from "@rat-king/envelope/canonical";
import * as Send from "@rat-king/lexicon/mailbox.send";
import {
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
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

const signer = "fixture-signer";

const primaryDid = "did:web:primary.example.invalid";

const copyDid = "did:web:copy.example.invalid";

const seed = Effect.gen(function* seed() {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();

  const sender = yield* identity("did:web:relay.example.invalid");
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

  return ConfigProvider.fromUnknown({
    CREDENTIALS_DIRECTORY: dir,
    RATKING_CONFIG: piConfig,
    RAT_KING_FRONT_DESK_CC: "copy",
    RAT_KING_FRONT_DESK_SIGNER: signer,
    RAT_KING_FRONT_DESK_TO: "primary",
    RAT_KING_SECRET_SOURCE: "systemd",
  });
});

const Path = Schema.Literals(["copy-refused", "primary-reply-lost", "all-ok"]);

const fixtureMailbox = (posted: Send.InputValue[], first: typeof Path.Type) =>
  HttpClient.make((request) =>
    Effect.gen(function* respond() {
      expect(request.url).toContain(Send.Method.path);

      if (!Predicate.isTagged(request.body, "Uint8Array")) {
        return yield* Effect.die("Expected JSON body");
      }

      const input = yield* Schema.decodeEffect(
        Schema.fromJsonString(Send.Input)
      )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

      posted.push(input);

      const { recipientDid, senderDid, messageId } = input.envelope.aad;

      if (first === "primary-reply-lost" && posted.length === 1) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "MailboxUnavailable" }, { status: 503 })
        );
      }

      if (
        first === "copy-refused" &&
        recipientDid === copyDid &&
        posted.length === 2
      ) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "Conflict" }, { status: 409 })
        );
      }

      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          receipt: {
            message: { messageId, senderDid },
            recipientDid,
            seq: 1,
            state: "accepted",
          },
        })
      );
    })
  );

it.effect.prop(
  "front desk journals the primary before copy, replays identical bytes after an uncertain receipt, and returns one stable receipt",
  [Schema.Boolean, Path],
  ([quiet, path]) =>
    Effect.gen(function* check() {
      const provider = yield* seed;
      const posted: Send.InputValue[] = [];

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
        Effect.provideService(
          HttpClient.HttpClient,
          fixtureMailbox(posted, path)
        ),
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
