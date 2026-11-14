import { expect, it } from "@effect/vitest";
import { Settings } from "@rat-king/ratking-client/config";
import { Directory } from "@rat-king/ratking-client/directory";
import { didFor } from "@rat-king/ratking-client/name";
import { SecretStore } from "@rat-king/ratking-client/secrets";
import { Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { HttpClient } from "effect/http";

import {
  EnvelopeJson,
  parseSeal,
  scriptSeal,
  scriptSendSealed,
} from "../../../stacks/nest/seal.ts";
import { parseSend, render, scriptSend } from "../../../stacks/nest/send.ts";
import { plaintext } from "../../envelope/src/canonical.ts";
import { document, identity } from "../../mailbox-client/test/identity.ts";

it.effect.prop(
  "encrypted script sends seal E2E and refuse recipients without agreement keys",
  { body: Schema.String, missingKey: Schema.Boolean },
  ({ body, missingKey }) =>
    Effect.gen(function* encrypted() {
      const template = "did:web:{agent}.agents.example.invalid";
      const sender = yield* identity(didFor(template, {}, "billing/alerts"));
      const recipient = yield* identity(didFor(template, {}, "switchboard"));
      const doc = yield* document(recipient);

      const target = {
        ...doc,
        keyAgreement: missingKey ? [] : doc.keyAgreement,
      };

      const services = Layer.mergeAll(
        Layer.succeed(
          SecretStore,
          SecretStore.of({
            add: () => Effect.void,
            exists: () => Effect.succeed(true),
            lease: () => Effect.succeed(Redacted.make(JSON.stringify(sender))),
          })
        ),
        Layer.succeed(
          Directory,
          Directory.of({
            clearRetired: () => Effect.void,
            documents: Effect.succeed([target]),
            importRetired: () => Effect.succeed({ added: 0, already: 0 }),
            list: Effect.succeed([]),
            nameOf: () => Effect.succeed(Option.none()),
            record: () => Effect.void,
            recordRetired: () => Effect.void,
            resolve: () =>
              Effect.succeed({
                did: recipient.did,
                document: target,
                name: "switchboard",
              }),
            retired: Effect.succeed({}),
          })
        ),
        Layer.succeed(
          Settings,
          Settings.of({
            askTimeoutMs: 1000,
            didTemplate: template,
            directory: "/example/directory.json",
            documents: [],
            encrypt: false,
            endpoint: "https://mailbox.example.invalid",
            issuer: Option.none(),
            refuse: [],
            relays: [],
            reserved: {},
            secretsCommand: "secrets",
            serviceDid: "did:web:mailbox.example.invalid",
            state: "/example/state",
          })
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("NO_NETWORK_EXPECTED"))
        )
      );

      const flags = [
        "--as",
        "billing/alerts",
        "--to",
        "switchboard",
        "--summary",
        "billing: invented",
        "--body",
        body,
        "--encrypt",
      ];

      const parsed = parseSeal(flags);
      const parsedSend = parseSend(flags);
      expect(Result.isSuccess(parsed)).toBe(true);
      expect(Result.isSuccess(parsedSend)).toBe(true);

      if (Result.isFailure(parsed) || Result.isFailure(parsedSend)) {
        return;
      }

      const outcome = yield* scriptSeal(parsed.success).pipe(
        Effect.result,
        Effect.provide(services)
      );

      if (missingKey) {
        expect(Result.isFailure(outcome)).toBe(true);

        const verdict = yield* scriptSend(parsedSend.success).pipe(
          Effect.provide(services)
        );

        expect(render(verdict).code).toBe(2);
        expect(render(verdict).stderr).toContain("NoAgreementKey");
      } else if (Result.isSuccess(outcome)) {
        const envelope = yield* Schema.decodeEffect(EnvelopeJson)(
          JSON.stringify(outcome.success.envelope)
        );

        expect(plaintext(envelope)).toBe(false);
        expect(parsed.success.encrypt).toBe(true);

        const legacy = yield* scriptSeal({
          ...parsed.success,
          encrypt: false,
        }).pipe(Effect.provide(services));

        const refused = yield* scriptSendSealed(
          "billing/alerts",
          JSON.stringify(legacy.envelope),
          true
        ).pipe(Effect.provide(services));

        expect(refused.code).toBe(2);
        expect(refused.stderr).toContain("EncryptionRequired");
      } else {
        throw new Error("Encrypted seal unexpectedly failed");
      }
    }).pipe(Effect.scoped)
);
