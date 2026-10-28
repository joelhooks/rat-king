/* oxlint-disable typescript/promise-function-async -- Lazy WebCrypto adapters. */
import { networkInterfaces } from "node:os";

import { NodeServices } from "@effect/platform-node";
import { Clock, Crypto, Effect, Exit, FileSystem, Schema } from "effect";
import type { Cause } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import type { HttpClientError } from "effect/http";

import { cryptoOperation } from "../../packages/envelope/src/webcrypto.ts";
import { MessageEvent } from "../../packages/lexicon/src/defs.ts";
import { Output as Names } from "../../packages/lexicon/src/identity.listNames.ts";
import { Output as Events } from "../../packages/lexicon/src/mailbox.list.ts";
import {
  base64url,
  serviceToken,
} from "../../packages/mailbox-client/src/auth.ts";
import type { MailboxKeyProof } from "./restore-drill-mailbox-projection.ts";
import {
  admissionKeyIdentity,
  messageKeyIdentity,
  MessageKey,
  requireMailboxKeys,
} from "./restore-drill-mailbox-projection.ts";
import {
  MailboxCounts,
  requireMailboxCounts,
} from "./restore-drill-proof-assertion.ts";
import {
  createProofProgress,
  ProofAssertionFailure,
  ProofHttpFailure,
  ProtocolErrorBody,
  protocolErrorCode,
  withProofCleanup,
} from "./restore-drill-proof-errors.ts";
import type {
  AssertionCode,
  ProofFailure,
  ProofProgress,
} from "./restore-drill-proof-errors.ts";

type NamePageParams = Record<string, string> & {
  cursor?: string;
  limit: string;
};

type MailboxPageParams = NamePageParams & { recipientDid: string };

const Text = Schema.NonEmptyString;

const Message = Schema.Struct({
  messageId: Text,
  recipientDid: Text,
  senderDid: Text,
});

const Inventory = Schema.Struct({
  mailboxes: Schema.Array(
    Schema.Struct({
      ...MailboxCounts.fields,
      did: Text,
      messageKeys: Schema.Array(MessageKey),
    })
  ),
  newest: Message,
});

const Rest = [Schema.Record(Schema.String, Schema.Json)];

const Binding = Schema.StructWithRest(
  Schema.Struct({ name: Text, text: Schema.optionalKey(Schema.String) }),
  Rest
);

const Manifest = Schema.StructWithRest(
  Schema.Struct({
    raw_metadata: Schema.StructWithRest(
      Schema.Struct({ bindings: Schema.Array(Binding) }),
      Rest
    ),
  }),
  Rest
);

const Document = Schema.StructWithRest(
  Schema.Struct({
    authentication: Schema.Array(Text),
    id: Text,
    keyAgreement: Schema.Array(Text),
    verificationMethod: Schema.Array(Schema.Json),
  }),
  Rest
);

const Documents = Schema.Array(Document);

const argument = (position: number) =>
  Schema.decodeUnknownSync(Text)(process.argv[position]);

const root = argument(2);

const publicBase = `http://127.0.0.1:${argument(3)}`;

const internalBase = `http://127.0.0.1:${argument(4)}`;

const filerBase = `http://127.0.0.1:${argument(5)}/buckets/${argument(6)}/`;

const knownName = argument(7);

const requireProof = (
  condition: boolean,
  assertionCode: typeof AssertionCode.Type
) =>
  condition
    ? Effect.void
    : Effect.fail(new ProofAssertionFailure({ assertionCode }));

class ProofStepFailure extends Schema.TaggedError<ProofStepFailure>()(
  "ProofStepFailure",
  {}
) {}

const writeMetadata = Effect.fn("writeMetadata")(function* writeMetadata(
  path: string,
  data: string
) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.writeFileString(path, data, { mode: 0o600 });
});

const progress = createProofProgress(
  Effect.fn("reportProgress")(function* reportProgress(state: ProofProgress) {
    yield* Effect.logInfo(JSON.stringify({ proofProgress: state }));
    yield* writeMetadata(`${root}/proof-progress.json`, JSON.stringify(state));
  })
);

type RequestFailure =
  | HttpClientError.HttpClientError
  | ProofHttpFailure
  | Schema.SchemaError
  | Cause.TimeoutError;

const proofFailures: ProofFailure[] = [];

let fixture:
  | {
      readonly restore: Effect.Effect<void, RequestFailure>;
      readonly reload: Effect.Effect<void, RequestFailure>;
    }
  | undefined;

const program = Effect.gen(function* restoreProof() {
  yield* progress.run(
    "namespace",
    Effect.suspend(() =>
      requireProof(
        Object.keys(networkInterfaces()).every((name) => name === "lo"),
        "NAMESPACE_NOT_PRIVATE"
      )
    )
  );

  const fs = yield* FileSystem.FileSystem;

  const inventory = yield* progress.run(
    "inventory",
    fs
      .readFileString(`${root}/inventory.json`)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Inventory))
        )
      )
  );

  const client = yield* HttpClient.HttpClient;

  const read = Effect.fn("read")(function* read(
    url: string,
    init?: {
      readonly method?: "POST";
      readonly headers?: Record<string, string>;
    }
  ) {
    const response = yield* (
      init?.method === "POST"
        ? client.post(url)
        : client.get(url, { headers: init?.headers })
    ).pipe(Effect.timeout("60 seconds"));

    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.json.pipe(
        Effect.timeout("60 seconds"),
        Effect.orElseSucceed(() => null)
      );

      const error = Schema.is(ProtocolErrorBody)(body)
        ? protocolErrorCode(body.error)
        : undefined;

      return yield* new ProofHttpFailure(
        error === undefined
          ? { status: response.status }
          : { error, status: response.status }
      );
    }

    return yield* response.json.pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json))
    );
  });

  const loaded = yield* progress.run(
    "auth-manifest",
    Effect.gen(function* loadManifest() {
      const pointer = yield* read(`${filerBase}deploy/current.json`).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Struct({ prefix: Text }))
        )
      );

      const url = `${filerBase}${pointer.prefix}/manifest.json`;
      const original = yield* read(url);

      return {
        manifest: yield* Schema.decodeUnknownEffect(Manifest)(original),
        original,
        url,
      };
    })
  );

  const { bindings } = loaded.manifest.raw_metadata;

  const binding = (name: string) => {
    const value = bindings.find((entry) => entry.name === name)?.text;

    return value === undefined
      ? Effect.fail(
          new ProofAssertionFailure({ assertionCode: "MISSING_BINDING" })
        )
      : Effect.succeed(value);
  };

  const put = Effect.fn("put")(function* put(value: typeof Schema.Json.Type) {
    const response = yield* client
      .put(loaded.url, { body: HttpBody.jsonUnsafe(value) })
      .pipe(Effect.timeout("60 seconds"));

    if (response.status < 200 || response.status >= 300) {
      return yield* new ProofHttpFailure({ status: response.status });
    }

    return yield* response.arrayBuffer.pipe(
      Effect.timeout("60 seconds"),
      Effect.asVoid
    );
  });

  const reload = read(`${internalBase}/reload`, { method: "POST" }).pipe(
    Effect.asVoid
  );

  fixture = {
    reload,
    restore: put(loaded.original),
  };
  const probeDid = "did:web:restore-drill.invalid";

  const signingKey = yield* progress.run(
    "auth-fixture",
    Effect.gen(function* authFixture() {
      const keys = yield* cryptoOperation(() =>
        crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"]
        )
      );

      if (!("publicKey" in keys)) {
        return yield* new ProofAssertionFailure({
          assertionCode: "EXPECTED_KEYPAIR",
        });
      }

      const exported = yield* cryptoOperation(() =>
        crypto.subtle.exportKey("jwk", keys.publicKey)
      );

      const jwk = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ crv: Text, kty: Text, x: Text, y: Text })
      )(exported);

      const originalDocs = yield* binding("DID_DOCUMENTS").pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Documents))
        )
      );

      const recipientDids = new Set([
        probeDid,
        ...inventory.mailboxes.map((mailbox) => mailbox.did),
      ]);

      const documents = originalDocs.filter(
        (doc) => !recipientDids.has(doc.id)
      );

      const patchedDocs = [...recipientDids].map((did) => {
        const doc = originalDocs.find((entry) => entry.id === did) ?? {
          authentication: [],
          id: did,
          keyAgreement: [],
          verificationMethod: [],
        };

        const id = `${did}#restore-drill`;

        return {
          ...doc,
          authentication: [...doc.authentication, id],
          verificationMethod: [
            ...doc.verificationMethod,
            { controller: did, id, publicKeyJwk: jwk },
          ],
        };
      });

      const replacements = new Map<string, string>([
        ["DID_DOCUMENTS", JSON.stringify([...documents, ...patchedDocs])],
      ]);

      for (const name of ["OPERATOR_DIDS", "LEASE_RESOLVERS"]) {
        const allowlist = yield* binding(name).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Array(Text))
            )
          )
        );

        replacements.set(name, JSON.stringify([...allowlist, probeDid]));
      }

      yield* put({
        ...loaded.manifest,
        raw_metadata: {
          ...loaded.manifest.raw_metadata,
          bindings: bindings.map((entry) => {
            const text = replacements.get(entry.name);

            return text === undefined ? entry : { ...entry, text };
          }),
        },
      });

      return keys.privateKey;
    })
  );

  yield* progress.run("reload", reload);

  const xrpc = Effect.fn("xrpc")(function* xrpc(
    method: string,
    params: Record<string, string>,
    issuer: string = probeDid
  ) {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const random = yield* Crypto.Crypto;
    const nonce = base64url(yield* random.randomBytes(16));
    const nsid = `sh.mschf.ratking.${method}`;
    const serviceDid = yield* binding("SERVICE_DID");

    const token = yield* serviceToken(
      {
        aud: `${serviceDid}#mailbox`,
        exp: now + 60,
        iat: now,
        iss: issuer,
        jti: nonce,
        lxm: nsid,
      },
      signingKey,
      "#restore-drill"
    );

    return yield* read(
      `${publicBase}/xrpc/${nsid}?${new URLSearchParams(params).toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  });

  const knownDid = yield* progress.run(
    "resolve-name",
    Effect.gen(function* resolveName() {
      let nameCursor: string | undefined;
      let known: { readonly did: string } | undefined;
      const nameCursors = new Set<string>();

      do {
        const params: NamePageParams = { limit: "100" };

        if (nameCursor !== undefined) {
          params.cursor = nameCursor;
        }

        const result = yield* xrpc("identity.listNames", params).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Names))
        );

        known = result.names.find((entry) => entry.name === knownName);

        if (known !== undefined) {
          break;
        }

        ({ cursor: nameCursor } = result);

        if (nameCursor !== undefined) {
          yield* requireProof(
            !nameCursors.has(nameCursor),
            "NAME_CURSOR_REPEATED"
          );
          nameCursors.add(nameCursor);
        }
      } while (nameCursor !== undefined);

      if (known !== undefined) {
        return known.did;
      }

      const template = yield* binding("ISSUER_DID_TEMPLATE");

      return template.replace("{agent}", knownName.replaceAll("/", "."));
    })
  );

  yield* progress.run(
    "resolve-lease",
    xrpc("runtime.resolveLease", { did: knownDid }).pipe(
      Effect.asVoid,
      Effect.catchTag("ProofHttpFailure", (failure) =>
        failure.status === 404 ? Effect.void : Effect.fail(failure)
      )
    )
  );
  let message: (typeof Message.Type & { readonly seq: number }) | undefined;
  const counts: { readonly events: number; readonly messages: number }[] = [];
  const mailboxKeyProofs: (typeof MailboxKeyProof.Type)[] = [];

  const fetchMailbox = Effect.fn("fetchMailbox")(function* fetchMailbox(
    mailbox: (typeof Inventory.Type.mailboxes)[number]
  ) {
    let cursor: string | undefined;
    let count = 0;
    let admissionEvents = 0;
    const keys = new Set<string>();
    const cursors = new Set<string>();

    do {
      const params: MailboxPageParams = {
        limit: "100",
        recipientDid: mailbox.did,
      };

      if (cursor !== undefined) {
        params.cursor = cursor;
      }

      const result = yield* xrpc("mailbox.list", params, mailbox.did).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Events))
      );

      count += result.events.length;

      for (const event of result.events) {
        if (Schema.is(MessageEvent)(event)) {
          admissionEvents += 1;
          keys.add(admissionKeyIdentity(event.receipt));

          if (
            mailbox.did === inventory.newest.recipientDid &&
            admissionKeyIdentity(event.receipt) ===
              messageKeyIdentity(inventory.newest)
          ) {
            message = { ...inventory.newest, seq: event.seq };
          }
        }
      }

      ({ cursor } = result);

      if (cursor !== undefined) {
        yield* requireProof(!cursors.has(cursor), "MAILBOX_CURSOR_REPEATED");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);

    return { admissionEvents, events: count, keys, messages: keys.size };
  });

  for (const [mailboxIndex, mailbox] of inventory.mailboxes.entries()) {
    const counted = yield* progress.run("fetch-events", fetchMailbox(mailbox));

    yield* progress.run(
      "compare-counts",
      Effect.try({
        catch: (error) =>
          Schema.is(ProofAssertionFailure)(error)
            ? error
            : new ProofStepFailure(),
        try: () => {
          const keyProof = requireMailboxKeys(
            mailbox.messageKeys,
            counted.keys,
            mailboxIndex
          );

          requireMailboxCounts(mailbox, counted, mailboxIndex);
          counts.push(counted);
          mailboxKeyProofs.push({
            ...keyProof,
            admissionEvents: counted.admissionEvents,
            duplicateAdmissionEvents:
              counted.admissionEvents - counted.messages,
            mailboxIndex,
          });
        },
      })
    );
  }

  yield* progress.run(
    "message-readback",
    Effect.suspend(() =>
      requireProof(message !== undefined, "NEWEST_MESSAGE_MISSING")
    )
  );
  yield* progress.run(
    "write-proof",
    fs.writeFileString(
      `${root}/api-proof.json`,
      JSON.stringify({
        knownDid,
        mailboxCounts: {
          events: counts.reduce((n, c) => n + c.events, 0),
          mailboxes: counts.length,
          messages: counts.reduce((n, c) => n + c.messages, 0),
          tolerance: 0,
        },
        mailboxKeyProofs,
        message,
      }),
      { mode: 0o600 }
    )
  );
});

const cleanup = Effect.suspend(() => {
  const acquired = fixture;

  return acquired === undefined
    ? Effect.void
    : progress
        .run("restore-auth", acquired.restore)
        .pipe(Effect.andThen(progress.run("restore-reload", acquired.reload)));
});

const report = Effect.fn("reportFailure")(function* reportFailure(
  failure: ProofFailure
) {
  proofFailures.push(failure);
  yield* Effect.logError(JSON.stringify(failure));
  yield* writeMetadata(
    `${root}/proof-errors.json`,
    JSON.stringify(proofFailures)
  );
});

const exit = await Effect.runPromiseExit(
  withProofCleanup(program, cleanup, report, progress.snapshot).pipe(
    Effect.provide([NodeServices.layer, FetchHttpClient.layer])
  )
);

if (Exit.isFailure(exit)) {
  process.exitCode = 1;
}
