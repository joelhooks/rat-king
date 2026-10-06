// @effect-diagnostics nodeBuiltinImport:off -- Owned loopback harness and private OS-temp fixtures.
// @effect-diagnostics globalFetch:off -- Signed-out ingress/version probes only.
// @effect-diagnostics asyncFunction:off -- fast-check owns asynchronous model commands.
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy Node and HTTP adapters. */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { seal, suite } from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import { clientLayer, MailboxClient } from "@rat-king/lexicon/mailbox-client";
import type { MailboxInterface } from "@rat-king/lexicon/mailbox-client";
import { Input as AckInput } from "@rat-king/lexicon/mailbox.ack";
import * as Deliver from "@rat-king/lexicon/mailbox.deliver";
import { Params as ListParams } from "@rat-king/lexicon/mailbox.list";
import type { OutputValue as SendOutput } from "@rat-king/lexicon/mailbox.send";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import type { MainValue as LeaseValue } from "@rat-king/lexicon/runtime.lease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { RatKingMailbox, layer, tid } from "@rat-king/mailbox-client";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Result,
  Schedule,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { build } from "esbuild";
import * as fc from "fast-check";
import { expect } from "vitest";

import {
  freePort,
  io,
  launch,
  ProofFailure,
} from "../../../packages/agent-runtime/test/celld-process.ts";
import { testDirectory } from "../../../tools/test/temp-directory.ts";
import { transportLayer } from "../cli/client.ts";
import { importSigning } from "../cli/identity.ts";
import type { IdentityValue } from "../cli/identity.ts";
import { DidResolver, staticResolver } from "../src/auth.ts";
import { generateIdentities, readSuiteIdentities } from "./suite-identities.ts";
import type { SuiteIdentities } from "./suite-identities.ts";

interface Target {
  baseUrl: string;
  serviceDid: string;
  version: string;
  commit: string;
  identitiesFile: string;
  agentDid?: string;
}

const nextTid = Effect.gen(function* nextTid() {
  const bytes = randomBytes(2);

  return tid(
    yield* Clock.currentTimeMillis,
    (bytes[0] ?? 0) * 256 + (bytes[1] ?? 0)
  );
});

const services = (
  target: Target,
  identities: typeof SuiteIdentities.Type,
  identity: IdentityValue
) => {
  const transport = transportLayer(
    target.baseUrl,
    `${target.serviceDid}#mailbox`,
    identity
  ).pipe(Layer.provide(FetchHttpClient.layer));

  return Layer.mergeAll(
    clientLayer.pipe(Layer.provide(transport)),
    transport,
    staticResolver(identities.documents),
    Layer.unwrap(
      Schema.decodeUnknownEffect(Schema.toType(Schema.Array(Defs.DidDocument)))(
        identities.documents
      ).pipe(
        Effect.map((documents) =>
          layer({
            documents,
            endpoint: target.baseUrl,
            identity,
            serviceDid: target.serviceDid,
          }).pipe(Layer.provide(FetchHttpClient.layer))
        )
      )
    )
  );
};

interface PagingInput {
  limit: number;
  recipientDid: string;
  cursor?: string;
}

const readPages = Effect.fn("Suite.readPages")(function* readPages(
  client: MailboxInterface,
  recipientDid: string
) {
  const events: (Defs.MessageEventValue | Defs.ReceiptEventValue)[] = [];
  let cursor: string | undefined;
  let throughSeq: number | undefined;

  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    const params: PagingInput = {
      limit: 1,
      recipientDid,
    };

    if (cursor !== undefined) {
      params.cursor = cursor;
    }

    const page = yield* client.list(
      yield* Schema.decodeUnknownEffect(Schema.toType(ListParams))(params)
    );

    throughSeq ??= page.throughSeq;

    expect(page.throughSeq).toBe(throughSeq);
    events.push(
      ...(yield* Schema.decodeUnknownEffect(
        Schema.toType(
          Schema.Array(Schema.Union([Defs.MessageEvent, Defs.ReceiptEvent]))
        )
      )(page.events))
    );

    if (page.cursor === undefined) {
      expect(new Set(events.map((event) => event.seq)).size).toBe(
        events.length
      );
      expect(events.map((event) => event.seq)).toEqual(
        events.map((event) => event.seq).toSorted((a, b) => a - b)
      );

      return events;
    }

    ({ cursor } = page);
  }

  return yield* new ProofFailure({ reason: "Paging exceeded 1000 events" });
});

interface Model {
  state: "empty" | "sent" | "delivered" | "acked";
  opened: boolean;
  agentAnswered: boolean;
}

interface Real {
  sender: MailboxInterface;
  recipient: MailboxInterface;
  identities: typeof SuiteIdentities.Type;
  target: Target;
  body: string;
  envelope?: Defs.EncryptedEnvelopeValue;
  admitted?: SendOutput;
  currentLease?: LeaseValue;
  staleLease?: LeaseValue | undefined;
}

const checkModel = Effect.fn("Suite.checkModel")(function* checkModel(
  model: Model,
  real: Real
) {
  const events = yield* readPages(
    real.recipient,
    real.identities.recipient.did
  );

  if (real.admitted === undefined) {
    expect(model.state).toBe("empty");

    return;
  }

  const reference = real.admitted.receipt.message;

  const relevant = events.filter(
    (event) =>
      event.receipt.message.messageId === reference.messageId &&
      event.receipt.message.senderDid === reference.senderDid
  );

  expect(relevant.filter(Schema.is(Defs.MessageEvent))).toHaveLength(1);
  const last = relevant.at(-1);
  expect(last?.receipt.state).toBe(
    model.state === "sent" ? "accepted" : model.state
  );
});

type Kind =
  | "send"
  | "resend"
  | "tamper"
  | "wrongSender"
  | "list"
  | "lease"
  | "ack"
  | "staleAck"
  | "open"
  | "agentQuestion";

const agentQuestion = Effect.fn("Suite.agentQuestion")(function* agentQuestion(
  real: Real
) {
  const { agent } = real.identities;

  if (!agent || agent.did !== real.target.agentDid) {
    return yield* new ProofFailure({
      reason: "Agent case requires matching hosted identity",
    });
  }

  const senderLayer = services(
    real.target,
    real.identities,
    real.identities.sender
  );

  const question = yield* RatKingMailbox.use((client) =>
    client.send(agent.did, "What is 2 + 2? Answer in one short line.")
  ).pipe(Effect.provide(senderLayer));

  const reply = yield* readPages(real.sender, real.identities.sender.did).pipe(
    Effect.flatMap((all) =>
      Effect.gen(function* findReply() {
        for (const event of all.filter(Schema.is(Defs.MessageEvent))) {
          const wire = yield* Schema.encodeEffect(Defs.EncryptedEnvelope)(
            event.envelope
          );

          const decoded = yield* Schema.decodeEffect(Defs.EncryptedEnvelope)(
            wire
          );

          const result = yield* RatKingMailbox.use((client) =>
            client.open(decoded)
          ).pipe(Effect.provide(senderLayer));

          if (
            result.replyTo?.messageId === question.receipt.message.messageId &&
            result.replyTo.senderDid === real.identities.sender.did
          ) {
            return result;
          }
        }

        return yield* new ProofFailure({ reason: "Reply not yet visible" });
      })
    ),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
    Effect.timeout("45 seconds")
  );

  expect(reply.verified).toBe(true);
  expect(reply.senderDid).toBe(agent.did);
  expect(reply.replyTo).toEqual(question.receipt.message);
  expect(reply.body.trim().length).toBeGreaterThan(0);

  const agentClient = yield* MailboxClient.pipe(
    Effect.provide(services(real.target, real.identities, agent))
  );

  yield* readPages(agentClient, agent.did).pipe(
    Effect.filterOrFail(
      (all) =>
        all
          .filter(Schema.is(Defs.ReceiptEvent))
          .some(
            (event) =>
              event.receipt.state === "acked" &&
              event.receipt.message.messageId ===
                question.receipt.message.messageId &&
              event.receipt.message.senderDid === real.identities.sender.did
          ),
      () => new ProofFailure({ reason: "Original not yet acked" })
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 20 }),
    Effect.timeout("10 seconds")
  );

  return yield* Effect.void;
});

const expectRejected = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  error: string,
  status: number
) =>
  Effect.gen(function* rejected() {
    const result = yield* operation.pipe(Effect.result);

    if (Result.isSuccess(result)) {
      return yield* new ProofFailure({ reason: "Expected route rejection" });
    }

    const failure = yield* Schema.decodeUnknownEffect(XrpcFailure)(
      result.failure
    );

    expect(failure.error).toBe(error);
    expect(failure.status).toBe(status);

    return yield* Effect.void;
  });

const messageCommand = Effect.fn("Suite.messageCommand")(
  function* messageCommand(
    kind: Exclude<Kind, "send" | "list" | "agentQuestion">,
    model: Model,
    real: Real
  ) {
    const recipientLayer = services(
      real.target,
      real.identities,
      real.identities.recipient
    );

    const { envelope, admitted } = real;

    if (!envelope || !admitted) {
      return yield* new ProofFailure({
        reason: "Command missing admitted message",
      });
    }

    switch (kind) {
      case "resend": {
        expect(yield* real.sender.send({ envelope })).toEqual(admitted);
        break;
      }

      case "tamper": {
        yield* expectRejected(
          real.sender.send({
            envelope: { ...envelope, ciphertext: new Uint8Array([1]) },
          }),
          "IdempotencyConflict",
          409
        );
        break;
      }

      case "wrongSender": {
        yield* expectRejected(
          real.recipient.send({ envelope }),
          "Forbidden",
          403
        );
        break;
      }

      case "lease": {
        real.staleLease = real.currentLease;

        if (real.currentLease !== undefined) {
          yield* real.recipient.releaseLease(
            yield* Schema.decodeUnknownEffect(Release.Input)({
              did: real.identities.recipient.did,
              generation: real.currentLease.generation,
              leaseId: real.currentLease.leaseId,
            })
          );
        }

        real.currentLease = (yield* real.recipient.acquireLease(
          yield* Schema.decodeUnknownEffect(Acquire.Input)({
            did: real.identities.recipient.did,
            expiresAt: DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60_000)
            ),
            harness: {
              $type: "sh.mschf.ratking.runtime.lease#pi",
              sessionId: "target-suite",
            },
          })
        )).lease;
        yield* real.recipient.deliver(
          yield* Schema.decodeUnknownEffect(Deliver.Input)({
            generation: real.currentLease.generation,
            leaseId: real.currentLease.leaseId,
            message: admitted.receipt.message,
            recipientDid: real.identities.recipient.did,
          })
        );

        if (real.staleLease) {
          expect(real.currentLease.generation).toBeGreaterThan(
            real.staleLease.generation
          );
        }

        model.state = "delivered";
        break;
      }

      case "ack": {
        const current = real.currentLease;

        if (!current) {
          return yield* new ProofFailure({
            reason: "Ack missing lease",
          });
        }

        const result = yield* real.recipient.ack(
          yield* Schema.decodeUnknownEffect(Schema.toType(AckInput))({
            generation: current.generation,
            leaseId: current.leaseId,
            message: admitted.receipt.message,
            recipientDid: envelope.aad.recipientDid,
          })
        );

        expect(result.receipt.state).toBe("acked");
        model.state = "acked";
        break;
      }

      case "staleAck": {
        const stale = real.staleLease;

        if (stale !== undefined) {
          yield* expectRejected(
            real.recipient.ack(
              yield* Schema.decodeUnknownEffect(Schema.toType(AckInput))({
                generation: stale.generation,
                leaseId: stale.leaseId,
                message: admitted.receipt.message,
                recipientDid: envelope.aad.recipientDid,
              })
            ),
            "LeaseMismatch",
            409
          );
        }

        break;
      }

      case "open": {
        const wire = yield* Schema.encodeEffect(Defs.EncryptedEnvelope)(
          envelope
        );

        const decoded = yield* Schema.decodeEffect(Defs.EncryptedEnvelope)(
          wire
        );

        const opened = yield* RatKingMailbox.use((client) =>
          client.open(decoded)
        ).pipe(Effect.provide(recipientLayer));

        expect(opened).toMatchObject({
          body: real.body,
          senderDid: real.identities.sender.did,
          tid: envelope.aad.messageId,
          verified: true,
        });
        model.opened = true;
        break;
      }

      default: {
        break;
      }
    }

    return yield* Effect.void;
  }
);

class Command implements fc.AsyncCommand<Model, Real> {
  readonly kind: Kind;

  constructor(kind: Kind) {
    this.kind = kind;
  }
  check(model: Readonly<Model>) {
    switch (this.kind) {
      case "send": {
        return model.state === "empty" || model.state === "acked";
      }

      case "list": {
        return true;
      }

      case "agentQuestion": {
        return !model.agentAnswered;
      }

      case "ack": {
        return model.state === "delivered";
      }

      case "lease": {
        return model.state === "sent" || model.state === "delivered";
      }

      case "staleAck": {
        return model.state === "delivered" || model.state === "acked";
      }

      case "open":
      case "resend":
      case "tamper":
      case "wrongSender": {
        return model.state !== "empty";
      }

      default: {
        const unreachable: never = this.kind;

        return unreachable;
      }
    }
  }
  async run(model: Model, real: Real) {
    const { kind } = this;

    // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check AsyncCommand requires a Promise at this bridge; the owning suite uses it.live.
    await Effect.runPromise(
      Effect.gen(function* command() {
        const senderLayer = services(
          real.target,
          real.identities,
          real.identities.sender
        );

        switch (kind) {
          case "send": {
            const payload = yield* Schema.decodeUnknownEffect(
              Schema.toType(Defs.SigningPayload)
            )({
              aad: {
                messageId: yield* nextTid,
                recipientDid: real.identities.recipient.did,
                recipientKeyId: `${real.identities.recipient.did}#encryption`,
                senderDid: real.identities.sender.did,
              },
              body: new TextEncoder().encode(real.body),
              suite,
              version: 1,
            });

            const envelope = yield* Effect.gen(function* encrypt() {
              const resolver = yield* DidResolver;

              return yield* seal({
                payload,
                recipientKey: yield* resolver.resolve(
                  real.identities.recipient.did,
                  payload.aad.recipientKeyId,
                  "keyAgreement"
                ),
                recipientKeyId: payload.aad.recipientKeyId,
                signingKey: yield* importSigning(real.identities.sender),
                signingKeyId: `${real.identities.sender.did}#atproto`,
              });
            }).pipe(Effect.provide(senderLayer));

            real.envelope = envelope;
            real.admitted = yield* real.sender.send({ envelope });
            model.state = "sent";
            model.opened = false;
            break;
          }

          case "list": {
            break;
          }

          case "agentQuestion": {
            if (real.target.agentDid !== undefined) {
              yield* agentQuestion(real);
            }

            model.agentAnswered = true;
            break;
          }

          case "ack":
          case "lease":
          case "open":
          case "resend":
          case "staleAck":
          case "tamper":
          case "wrongSender": {
            yield* messageCommand(kind, model, real);
            break;
          }

          default: {
            const unreachable: never = kind;

            return yield* Effect.die(unreachable);
          }
        }

        yield* checkModel(model, real);

        return yield* Effect.void;
      })
    );
  }
  toString() {
    return this.kind;
  }
}

const Runs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(20)
);

export const targetProof = Effect.fn("Suite.targetProof")(function* targetProof(
  target: Target
) {
  const identities = yield* readSuiteIdentities(target.identitiesFile);

  if (
    target.agentDid !== undefined &&
    identities.agent?.did !== target.agentDid
  ) {
    return yield* new ProofFailure({
      reason: "Agent DID requires matching private agent identity",
    });
  }

  const numRuns = yield* Schema.decodeUnknownEffect(Runs)(
    Number(process.env.RAT_KING_SUITE_NUM_RUNS ?? "2")
  );

  const version = yield* io(() =>
    fetch(new URL("/.well-known/rat-king/version", target.baseUrl))
  );

  expect(version.status).toBe(200);
  expect(yield* io(() => version.json())).toEqual({
    commit: target.commit,
    version: target.version,
  });

  const signedOut = new URL(
    "/xrpc/sh.mschf.ratking.mailbox.list",
    target.baseUrl
  );

  signedOut.searchParams.set("recipientDid", identities.recipient.did);
  expect((yield* io(() => fetch(signedOut))).status).toBe(401);

  const sender = yield* MailboxClient.pipe(
    Effect.provide(services(target, identities, identities.sender))
  );

  const recipient = yield* MailboxClient.pipe(
    Effect.provide(services(target, identities, identities.recipient))
  );

  const kinds: Kind[] = [
    "send",
    "resend",
    "tamper",
    "wrongSender",
    "list",
    "lease",
    "ack",
    "staleAck",
    "open",
    ...(target.agentDid === undefined ? [] : ["agentQuestion" as const]),
  ];

  const commands = fc.commands(
    [fc.constantFrom(...kinds).map((kind) => new Command(kind))],
    { maxCommands: 12 }
  );

  const required: Kind[] = [
    "send",
    "resend",
    "tamper",
    "wrongSender",
    "list",
    "open",
    "lease",
    "lease",
    "staleAck",
    "ack",
    "list",
    ...(target.agentDid === undefined ? [] : ["agentQuestion" as const]),
  ];

  yield* Effect.tryPromise({
    catch: (cause) =>
      new ProofFailure({
        reason:
          cause instanceof Error && cause.cause instanceof Error
            ? `${cause.message}\n${cause.cause.message}`
            : String(cause),
      }),
    try: () =>
      fc.assert(
        fc.asyncProperty(
          fc.string({ maxLength: 64, minLength: 1 }),
          commands,
          async (body, generated) => {
            const model: Model = {
              agentAnswered: false,
              opened: false,
              state: "empty",
            };

            const real: Real = { body, identities, recipient, sender, target };
            await fc.asyncModelRun(
              () => ({ model, real }),
              [...required.map((kind) => new Command(kind)), ...generated]
            );
            expect(model.state).not.toBe("empty");

            if (real.currentLease !== undefined) {
              // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check requires a Promise; the owning target suite uses it.live.
              await Effect.runPromiseWith(Context.empty())(
                real.recipient.releaseLease(
                  Schema.decodeUnknownSync(Release.Input)({
                    did: identities.recipient.did,
                    generation: real.currentLease.generation,
                    leaseId: real.currentLease.leaseId,
                  })
                )
              );
            }
          }
        ),
        { endOnFailure: true, numRuns }
      ),
  });
  yield* Effect.sync(() =>
    process.stdout.write(
      `P6 target model suite: runs=${numRuns}; version=${target.version}; commit=${target.commit}; production routes; send/resend/tamper/wrong-sender/paging/lease/ack/stale-ack/open/401=passed; agent=${target.agentDid === undefined ? "skipped" : "verified reply + original acked"}; keys omitted\n`
    )
  );

  return yield* Effect.void;
});

const deadlineRuns = Number(process.env.RAT_KING_SUITE_NUM_RUNS ?? "2");

const suiteDeadline =
  60_000 +
  30_000 *
    (Number.isInteger(deadlineRuns) && deadlineRuns >= 1 && deadlineRuns <= 20
      ? deadlineRuns
      : 2);

const baseUrl = process.env.RAT_KING_SUITE_BASE_URL;

const serviceDid = process.env.RAT_KING_SUITE_SERVICE_DID;

const identitiesFile = process.env.RAT_KING_SUITE_IDENTITIES_FILE;

const version = process.env.RAT_KING_SUITE_VERSION;

const commit = process.env.RAT_KING_SUITE_COMMIT;

const agentDid = process.env.RAT_KING_SUITE_AGENT_DID;

it.live.skipIf(
  [baseUrl, serviceDid, identitiesFile, version, commit].some(
    (value) => value === undefined || value === ""
  )
)(
  "production recipient outcome against configured target",
  () => {
    const target: Target = {
      baseUrl: baseUrl ?? "",
      commit: commit ?? "",
      identitiesFile: identitiesFile ?? "",
      serviceDid: serviceDid ?? "",
      version: version ?? "",
    };

    if (agentDid !== undefined && agentDid !== "") {
      target.agentDid = agentDid;
    }

    return targetProof(target);
  },
  suiteDeadline
);

const binary = process.env.RAT_KING_CELLD;

it.live.skipIf(binary === undefined || binary === "")(
  "same production target suite against celld dev with faux hosted agent",
  () =>
    Effect.gen(function* localTarget() {
      const directory = yield* Effect.acquireRelease(
        io(() => testDirectory("rat-king-p6-suite-")),
        (owned) => io(owned.remove).pipe(Effect.orDie)
      ).pipe(Effect.map((owned) => owned.directory));

      const privateFile = path.join(directory, "identities.json");

      const identities = yield* generateIdentities({
        documents: path.join(directory, "documents.json"),
        hostedAgent: true,
        identities: privateFile,
      }).pipe(Effect.provide(NodeServices.layer));

      const { agent } = identities;

      if (!agent) {
        return yield* new ProofFailure({ reason: "Missing generated agent" });
      }

      yield* io(() =>
        build({
          bundle: true,
          define: {
            __BUNDLE_COMMIT__: JSON.stringify("p6-local-proof"),
            __BUNDLE_VERSION__: JSON.stringify("p6-proof"),
          },
          entryPoints: [path.resolve("apps/mailbox/src/hosted-worker.ts")],
          external: ["cloudflare:workers"],
          format: "esm",
          minify: true,
          outfile: path.join(directory, "worker.js"),
          platform: "browser",
          target: "es2023",
        })
      );
      yield* io(() =>
        writeFile(
          path.join(directory, "wrangler.json"),
          JSON.stringify({
            compatibility_date: "2026-10-04",
            durable_objects: {
              bindings: [
                { class_name: "Mailbox", name: "MAILBOX" },
                { class_name: "AuthTokens", name: "AUTH_TOKENS" },
                { class_name: "Agent", name: "AGENT" },
              ],
            },
            main: "worker.js",
            migrations: [
              {
                new_sqlite_classes: ["Mailbox", "AuthTokens", "Agent"],
                tag: "v1",
              },
            ],
            name: "mailbox-target-proof",
            vars: {
              AGENT_MODEL: "faux",
              DID_DOCUMENTS: JSON.stringify(identities.documents),
              HOSTED_AGENTS: JSON.stringify([agent.did]),
              SERVICE_DID: "did:web:service.example.invalid",
            },
          }),
          { mode: 0o600 }
        )
      );
      yield* io(() =>
        writeFile(
          path.join(directory, ".dev.vars"),
          `AGENT_IDENTITIES_CREDENTIAL=${JSON.stringify([agent])}\n`,
          { mode: 0o600 }
        )
      );
      const port = yield* freePort;
      yield* launch(binary ?? "", directory, port);

      return yield* targetProof({
        agentDid: agent.did,
        baseUrl: `http://127.0.0.1:${port}`,
        commit: "p6-local-proof",
        identitiesFile: privateFile,
        serviceDid: "did:web:service.example.invalid",
        version: "p6-proof",
      });
    }).pipe(Effect.scoped),
  suiteDeadline
);
