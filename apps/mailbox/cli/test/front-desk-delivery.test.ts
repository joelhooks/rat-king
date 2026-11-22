import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { plaintext } from "@rat-king/envelope/canonical";
import * as Send from "@rat-king/lexicon/mailbox.send";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Predicate,
  Result,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import {
  document,
  identity,
} from "../../../../packages/mailbox-client/test/identity.ts";
import {
  loadSettings,
  Settings,
} from "../../../../packages/ratking-client/src/config.ts";
import { directoryLayer } from "../../../../packages/ratking-client/src/directory.ts";
import { secretStoreLayer } from "../../../../packages/ratking-client/src/secrets.ts";
import { sendFrontDesk } from "../../../../stacks/nest/front-desk-command.ts";

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

const fixtureMailbox = (posted: Send.InputValue[], rejectCopy: boolean) =>
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

      return HttpClientResponse.fromWeb(
        request,
        rejectCopy && recipientDid === copyDid
          ? Response.json({ error: "Conflict" }, { status: 409 })
          : Response.json({
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
  "front desk encrypts both copies, preserves quiet delivery, and emits a primary receipt only after both accept",
  [Schema.Boolean, Schema.Boolean],
  ([quiet, rejectCopy]) =>
    Effect.gen(function* check() {
      const provider = yield* seed;
      const posted: Send.InputValue[] = [];

      const verdict = yield* Effect.gen(function* send() {
        const settings = yield* loadSettings();

        return yield* sendFrontDesk({
          body: "private fixture",
          id: "fixture",
          quiet,
          summary: "sample",
        }).pipe(
          Effect.provide([directoryLayer, secretStoreLayer]),
          Effect.provideService(Settings, settings),
          Effect.provideService(
            HttpClient.HttpClient,
            fixtureMailbox(posted, rejectCopy)
          )
        );
      }).pipe(Effect.provide(ConfigProvider.layer(provider)), Effect.result);

      expect(
        posted.map((entry) => [
          entry.envelope.aad.recipientDid,
          plaintext(entry.envelope),
          entry.woke,
          entry.wakeReason,
        ])
      ).toEqual([
        [primaryDid, false, !quiet, quiet ? "quiet" : "to"],
        [copyDid, false, false, "cc"],
      ]);

      if (rejectCopy) {
        expect(Result.isFailure(verdict)).toBe(true);
      } else {
        expect(verdict).toEqual(
          Result.succeed({
            messageId: posted[0]?.envelope.aad.messageId,
            ok: true,
          })
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 } }
);
