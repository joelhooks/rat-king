// @effect-diagnostics asyncFunction:off -- fast-check asyncModelRun drives Effect programs.
/* oxlint-disable typescript/promise-function-async -- fast-check asyncModelRun and the Effect HTTP test adapter are Promise boundaries. */
import { it } from "@effect/vitest";
import { seal } from "@rat-king/envelope";
import { canonical, plaintextSuite } from "@rat-king/envelope/canonical";
import * as Defs from "@rat-king/lexicon/defs";
import * as Send from "@rat-king/lexicon/mailbox.send";
import {
  ownIdentity,
  prepare,
  PreparedMailbox,
  seal as publicSealMessage,
  sendSealed as publicSendSealed,
} from "@rat-king/mailbox-client";
import { Settings } from "@rat-king/ratking-client/config";
import { Directory, UnknownName } from "@rat-king/ratking-client/directory";
import { didFor } from "@rat-king/ratking-client/name";
import { PayloadJson } from "@rat-king/ratking-client/payload";
import { SecretStore } from "@rat-king/ratking-client/secrets";
import {
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect, vi } from "vitest";

import { projectLine } from "../../../stacks/nest/drain.ts";
import {
  CONFLICT_STDERR,
  EnvelopeJson,
  parseSeal,
  scriptSeal,
  scriptSendSealed,
  sealedSendFlags,
} from "../../../stacks/nest/seal.ts";
import type { SealedValue } from "../../../stacks/nest/seal.ts";
import type { LexJson } from "../../lexicon/src/runtime.ts";
import { base64url } from "../../mailbox-client/src/auth.ts";
import { importSigning } from "../../mailbox-client/src/identity.ts";
import * as Tid from "../../mailbox-client/src/tid.ts";
import { document, identity } from "../../mailbox-client/test/identity.ts";

const TEMPLATE = "did:web:{agent}.agents.example.invalid";

const SENDER = "acme/job";

const PRIMARY = "acme/inbox";

const SECRET = "example_job_identity";

const INBOX_ENTRY = "example_inbox_identity";

const ENDPOINT = "https://mailbox.example.invalid";

const SERVICE = "did:web:mailbox.example.invalid";

const did = (name: string) => didFor(TEMPLATE, {}, name);

const Step = Schema.Literals([
  "seal",
  "send",
  "lost",
  "offline",
  "conflict",
  "reply",
  "mismatch",
  "refused",
]);

type StepValue = typeof Step.Type;

const Printed = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, seq: Schema.Int })
);

interface Model {
  readonly receipts: Map<string, number>;
  seq: number;
}

interface Server {
  readonly admitted: Map<
    string,
    {
      readonly bytes: string;
      readonly envelope: Defs.EncryptedEnvelopeValue;
      readonly receipt: Defs.ReceiptValue;
    }
  >;
  mode: "normal" | "offline" | "lost" | "refused";
  requests: number;
  seq: number;
}

const key = (envelope: Defs.EncryptedEnvelopeValue) =>
  JSON.stringify([envelope.aad.senderDid, envelope.aad.messageId]);

const remember = (model: Model, value: SealedValue) => {
  const { envelope } = value;
  {
    const id = JSON.stringify([envelope.aad.senderDid, envelope.aad.messageId]);

    if (!model.receipts.has(id)) {
      model.seq += 1;
      model.receipts.set(id, model.seq);
    }
  }
};

const fakeMailbox = (server: Server) =>
  HttpClient.make((request) =>
    Effect.gen(function* admission() {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(`/xrpc/${Send.Method.nsid}`);
      expect(Predicate.isTagged(request.body, "Uint8Array")).toBe(true);

      if (!Predicate.isTagged(request.body, "Uint8Array")) {
        throw new Error("Missing JSON body");
      }

      const input = yield* Schema.decodeEffect(
        Schema.fromJsonString(Send.Input)
      )(new TextDecoder().decode(request.body.body));

      expect(input.leaseId).toBeUndefined();
      server.requests += 1;

      const respond = (body: LexJson, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));

      if (server.mode === "offline") {
        return respond({ error: "MailboxUnavailable" }, 503);
      }

      if (server.mode === "refused") {
        return respond(
          { error: "Retired", message: "current row is acme/watch-2" },
          410
        );
      }

      const id = key(input.envelope);
      const bytes = base64url(canonical(input.envelope));
      const existing = server.admitted.get(id);

      if (existing !== undefined && existing.bytes !== bytes) {
        return respond({ error: "Conflict" }, 409);
      }

      const receipt =
        existing?.receipt ??
        (yield* Schema.decodeUnknownEffect(Schema.toType(Defs.Receipt))({
          message: {
            messageId: input.envelope.aad.messageId,
            senderDid: input.envelope.aad.senderDid,
          },
          recipientDid: input.envelope.aad.recipientDid,
          seq: server.seq + 1,
          state: "accepted",
        }));

      if (existing === undefined) {
        server.seq += 1;
        server.admitted.set(id, { bytes, envelope: input.envelope, receipt });
      }

      if (server.mode === "lost") {
        return respond({ error: "MailboxUnavailable" }, 503);
      }

      return respond(yield* Schema.encodeEffect(Send.Output)({ receipt }));
    }).pipe(Effect.orDie)
  );

it.live.prop(
  "sealed journals replay unchanged with original receipts, conflict exits 5, transport exits 3 without duplicates, and drained replies target messageId",
  [Schema.Array(Step).check(Schema.isMaxLength(12))],
  ([steps]) =>
    Effect.gen(function* sealedSendModel() {
      const sender = yield* identity(did(SENDER));
      const inbox = yield* identity(did(PRIMARY));
      const documents = new Map<string, Defs.DidDocumentValue>();

      for (const own of [sender, inbox]) {
        documents.set(own.did, yield* document(own));
      }

      const server: Server = {
        admitted: new Map(),
        mode: "normal",
        requests: 0,
        seq: 0,
      };

      const services = Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, fakeMailbox(server)),
        Layer.succeed(
          SecretStore,
          SecretStore.of({
            add: () => Effect.void,
            exists: () => Effect.succeed(true),
            lease: (name) =>
              Effect.succeed(
                Redacted.make(
                  JSON.stringify(name === INBOX_ENTRY ? inbox : sender)
                )
              ),
          })
        ),
        Layer.succeed(
          Directory,
          Directory.of({
            clearRetired: () => Effect.void,
            documents: Effect.succeed([...documents.values()]),
            importRetired: () => Effect.succeed({ added: 0, already: 0 }),
            list: Effect.succeed([]),
            nameOf: () => Effect.succeed(Option.none()),
            record: () => Effect.void,
            recordRetired: () => Effect.void,
            resolve: (name) => {
              const doc = documents.get(did(name));

              return doc === undefined
                ? Effect.fail(
                    new UnknownName({
                      name,
                      reason: "Invented name not registered",
                    })
                  )
                : Effect.succeed({ did: doc.id, document: doc, name });
            },
            retired: Effect.succeed({}),
          })
        ),
        Layer.succeed(
          Settings,
          Settings.of({
            askTimeoutMs: 1000,
            didTemplate: TEMPLATE,
            directory: "/example/directory.json",
            documents: [],
            encrypt: false,
            endpoint: ENDPOINT,
            issuer: Option.none(),
            refuse: [],
            relays: [],
            reserved: {},
            secretsCommand: "secrets",
            serviceDid: SERVICE,
            state: "/example/state",
          })
        )
      );

      const context = yield* Layer.build(services);
      const outer = yield* Effect.context();
      let journal: SealedValue;

      const newJournal = () =>
        scriptSeal({
          as: SECRET,
          body: "Job complete",
          summary: "Job result",
          to: PRIMARY,
        }).pipe(Effect.scoped, Effect.provide(context));

      const submit = (value: SealedValue, as = SECRET) =>
        scriptSendSealed(
          as,
          Schema.encodeSync(EnvelopeJson)(value.envelope)
        ).pipe(Effect.provide(context));

      const command = (step: StepValue): AsyncCommand<Model, Server> => ({
        check: () => true,
        run: async (model, real) => {
          const operation = Effect.gen(function* commandEffect() {
            real.mode = "normal";

            if (step === "seal") {
              const before = real.requests;
              journal = yield* newJournal();
              expect(real.requests).toBe(before);
              expect(journal.to).toBe(PRIMARY);
              expect(journal.envelope.aad.messageId).toBe(journal.messageId);
              expect(journal.envelope.aad.expiresAt).toBeUndefined();
            } else if (step === "send") {
              const result = yield* submit(journal);
              remember(model, journal);
              expect(result.code).toBe(0);
              expect(result.stdout).toHaveLength(1);

              for (const line of result.stdout) {
                const printed = yield* Schema.decodeEffect(Printed)(line);
                const entry = journal;

                expect(printed).toEqual({
                  id: entry.envelope.aad.messageId,
                  seq: model.receipts.get(
                    JSON.stringify([
                      entry.envelope.aad.senderDid,
                      entry.envelope.aad.messageId,
                    ])
                  ),
                });

                const admitted = real.admitted.get(
                  JSON.stringify([
                    entry.envelope.aad.senderDid,
                    entry.envelope.aad.messageId,
                  ])
                );

                expect(admitted?.bytes).toBe(
                  base64url(
                    canonical(
                      yield* Schema.decodeEffect(Defs.EncryptedEnvelope)(
                        entry.envelope
                      )
                    )
                  )
                );
              }
            } else if (step === "offline" || step === "lost") {
              journal = yield* newJournal();
              real.mode = step;
              const failed = yield* submit(journal);
              expect(failed.code).toBe(3);
              expect(failed.stderr).toMatch(/^UNCERTAIN:/u);
              expect(failed.stderr).toContain("same sealed JSON");

              if (step === "lost") {
                remember(model, journal);
              }

              real.mode = "normal";
              const retried = yield* submit(journal);
              remember(model, journal);
              expect(retried.code).toBe(0);
              expect(retried.stdout).toHaveLength(1);
            } else if (step === "conflict") {
              yield* submit(journal);
              remember(model, journal);
              const first = journal;

              const signingKey = yield* importSigning(sender);

              const payload = yield* Schema.decodeUnknownEffect(
                Schema.toType(Defs.SigningPayload)
              )({
                aad: first.envelope.aad,
                body: new TextEncoder().encode("changed"),
                suite: plaintextSuite,
                version: 1,
              });

              const changed = yield* seal({
                payload,
                recipientKey: signingKey,
                recipientKeyId: payload.aad.recipientKeyId,
                signingKey,
                signingKeyId: `${sender.did}#atproto`,
              });

              const conflict = yield* submit({
                ...journal,
                envelope: yield* Schema.encodeEffect(Defs.EncryptedEnvelope)(
                  changed
                ),
              });

              expect(conflict.code).toBe(5);
              expect(conflict.stderr).toBe(CONFLICT_STDERR);
            } else if (step === "reply") {
              const parsed = parseSeal([
                "--as",
                INBOX_ENTRY,
                "--to",
                SENDER,
                "--body",
                "Acknowledged",
                "--reply-to",
                journal.messageId,
                "--thread",
                journal.messageId,
              ]);

              if (Result.isFailure(parsed)) {
                throw new Error(parsed.failure);
              }

              const reply = yield* scriptSeal(parsed.success).pipe(
                Effect.scoped,
                Effect.provide(context)
              );

              const result = yield* submit(reply, INBOX_ENTRY);
              expect(result.code).toBe(0);
              remember(model, reply);
              const entry = reply;

              const envelope = yield* Schema.decodeEffect(
                Defs.EncryptedEnvelope
              )(entry.envelope);

              const opened = yield* Effect.gen(function* openReply() {
                const client = yield* prepare({
                  endpoint: ENDPOINT,
                  own: yield* ownIdentity(sender),
                  peers: [...documents.values()],
                  serviceDid: SERVICE,
                });

                return yield* client.open(envelope);
              }).pipe(Effect.scoped, Effect.provide(context));

              const event = yield* Schema.decodeUnknownEffect(
                Schema.toType(Defs.MessageEvent)
              )({
                envelope,
                receipt: real.admitted.get(key(envelope))?.receipt,
                seq: model.seq,
              });

              const line = yield* projectLine(
                event,
                Option.some(opened),
                Option.some(PRIMARY)
              );

              expect(line.replyTo).toBe(journal.messageId);
              expect(line.kind).toBe("reply");

              const payload = yield* Schema.decodeEffect(PayloadJson)(
                opened.body
              );

              expect(payload.thread).toBe(journal.messageId);
            } else if (step === "mismatch") {
              const before = real.requests;

              const result = yield* submit({
                ...journal,
                envelope: {
                  ...journal.envelope,
                  aad: { ...journal.envelope.aad, senderDid: inbox.did },
                },
              });

              expect(result.code).toBe(2);
              expect(result.stderr).toContain("Unauthorized");
              expect(real.requests).toBe(before);
            } else {
              journal = yield* newJournal();
              real.mode = "refused";
              const result = yield* submit(journal);
              expect(result.code).toBe(2);
              expect(result.stdout).toHaveLength(0);
              expect(result.stderr).toContain("Retired");
              real.mode = "normal";
              expect((yield* submit(journal)).code).toBe(0);
              remember(model, journal);
            }

            expect(real.admitted.size).toBe(model.receipts.size);
            expect(real.seq).toBe(model.seq);
          });

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- asyncModelRun requires a Promise per command.
          await Effect.runPromiseWith(outer)(operation);
        },
        toString: () => step,
      });

      expect(sealedSendFlags(["--sealed", "-", "--as", SECRET])._tag).toBe(
        "Success"
      );
      yield* Effect.promise(async () => {
        await asyncModelRun(
          () => ({ model: { receipts: new Map(), seq: 0 }, real: server }),
          [
            "seal",
            "send",
            "send",
            "conflict",
            "offline",
            "lost",
            "reply",
            "mismatch",
            "refused",
            ...steps,
          ].map((step) => command(Schema.decodeUnknownSync(Step)(step)))
        );
      });
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 15 }, timeout: 120_000 }
);

it.effect.prop(
  "public sealing shares nest payload bytes and sealed retries preserve one delivery and receipt",
  [
    Schema.String,
    Schema.Array(Schema.Literals(["send", "fence", "sender"])).check(
      Schema.isMaxLength(8)
    ),
  ],
  ([body, steps]) =>
    Effect.gen(function* publicProof() {
      const sender = yield* identity(did(SENDER));
      const inbox = yield* identity(did(PRIMARY));
      const docs = yield* Effect.forEach([sender, inbox], document);

      const server: Server = {
        admitted: new Map(),
        mode: "normal",
        requests: 0,
        seq: 0,
      };

      const http = fakeMailbox(server);

      const client = yield* prepare({
        endpoint: ENDPOINT,
        names: { from: SENDER, peers: { [inbox.did]: PRIMARY } },
        own: yield* ownIdentity(sender),
        peers: docs,
        serviceDid: SERVICE,
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));

      const yieldDoc = yield* document(inbox);

      const services = Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, http),
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
            documents: Effect.succeed(docs),
            importRetired: () => Effect.succeed({ added: 0, already: 0 }),
            list: Effect.succeed([]),
            nameOf: () => Effect.succeed(Option.none()),
            record: () => Effect.void,
            recordRetired: () => Effect.void,
            resolve: () =>
              Effect.succeed({
                did: inbox.did,
                document: yieldDoc,
                name: PRIMARY,
              }),
            retired: Effect.succeed({}),
          })
        ),
        Layer.succeed(
          Settings,
          Settings.of({
            askTimeoutMs: 1000,
            didTemplate: TEMPLATE,
            directory: "/example/directory.json",
            documents: [],
            encrypt: false,
            endpoint: ENDPOINT,
            issuer: Option.none(),
            refuse: [],
            relays: [],
            reserved: {},
            secretsCommand: "secrets",
            serviceDid: SERVICE,
            state: "/example/state",
          })
        )
      );

      const fixedId = "3m3m3m3m3m3m3";

      const replyTo = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.MessageRef)
      )({ messageId: fixedId, senderDid: inbox.did });

      const spy = vi.spyOn(Tid, "randomTid").mockReturnValue(fixedId);

      const publicSeal = yield* publicSealMessage(inbox.did, body, {
        encrypt: false,
        replyTo,
        summary: "Shared summary",
      }).pipe(
        Effect.provideService(PreparedMailbox, client),
        Effect.ensuring(
          Effect.sync(() => {
            spy.mockRestore();
          })
        )
      );

      const nestSpy = vi.spyOn(Tid, "randomTid").mockReturnValue(fixedId);

      const nestSeal = yield* scriptSeal({
        as: SECRET,
        body,
        replyTo: fixedId,
        summary: "Shared summary",
        to: PRIMARY,
      }).pipe(
        Effect.provide(services),
        Effect.ensuring(
          Effect.sync(() => {
            nestSpy.mockRestore();
          })
        )
      );

      const reader = yield* prepare({
        endpoint: ENDPOINT,
        own: yield* ownIdentity(inbox),
        peers: docs,
        serviceDid: SERVICE,
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));

      const opened = yield* reader.open(publicSeal.envelope);

      const nestOpened = yield* reader.open(
        yield* Schema.decodeEffect(Defs.EncryptedEnvelope)(nestSeal.envelope)
      );

      expect(opened.body).toBe(nestOpened.body);
      expect(JSON.parse(opened.body)).toEqual({
        body,
        cc: [],
        from: SENDER,
        kind: "reply",
        replyTo: fixedId,
        summary: "Shared summary",
        thread: fixedId,
        to: PRIMARY,
      });
      expect(publicSeal.messageId).toBe(fixedId);
      const outer = yield* Effect.context();

      const commands: AsyncCommand<{ sent: boolean }, Server>[] = [
        "send",
        "send",
        ...steps,
      ].map((step) => ({
        check: () => true,
        run: async (model, real) => {
          const operation = Effect.gen(function* submitPublic() {
            const envelope =
              step === "sender"
                ? yield* Schema.decodeUnknownEffect(
                    Schema.toType(Defs.EncryptedEnvelope)
                  )({
                    ...publicSeal.envelope,
                    aad: { ...publicSeal.envelope.aad, senderDid: inbox.did },
                  })
                : publicSeal.envelope;

            const outcome = yield* publicSendSealed(
              envelope,
              step === "fence"
                ? { did: inbox.did, generation: 1, leaseId: "wrong-fence" }
                : undefined
            ).pipe(Effect.provideService(PreparedMailbox, client));

            expect(outcome._tag).toBe(
              step === "send" ? "Accepted" : "NotAttempted"
            );

            if (Predicate.isTagged(outcome, "Accepted")) {
              expect(outcome.receipt).toEqual({
                message: { messageId: fixedId, senderDid: sender.did },
                recipientDid: inbox.did,
                seq: 1,
                state: "accepted",
              });
              model.sent = true;
            }

            expect(real.admitted.size).toBe(model.sent ? 1 : 0);
            expect(real.seq).toBe(model.sent ? 1 : 0);
            expect(real.admitted.get(key(publicSeal.envelope))?.bytes).toBe(
              base64url(canonical(publicSeal.envelope))
            );
          });

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- asyncModelRun requires a Promise per command.
          await Effect.runPromiseWith(outer)(operation);
        },
        toString: () => step,
      }));

      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({ model: { sent: false }, real: server }),
          commands
        )
      );
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 15 } }
);
