// @effect-diagnostics asyncFunction:off -- Standalone Node subprocess in the isolated restore job.
import { networkInterfaces } from "node:os";

import { NodeServices } from "@effect/platform-node";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";

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
  proofFailureMetadata,
  protocolErrorCode,
  runProofEffect,
  withProofCleanup,
} from "./restore-drill-proof-errors.ts";
import type {
  AssertionCode,
  ProofFailure,
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
): void => {
  if (!condition) {
    throw new ProofAssertionFailure({ assertionCode });
  }
};

const writeMetadata = async (path: string, data: string): Promise<void> => {
  await runProofEffect(
    Effect.gen(function* metadataWriter() {
      const fs = yield* FileSystem.FileSystem;

      yield* fs.writeFileString(path, data, { mode: 0o600 });
    }).pipe(Effect.provide(NodeServices.layer))
  );
};

const progress = createProofProgress(async (state) => {
  await runProofEffect(
    Effect.logInfo(JSON.stringify({ proofProgress: state }))
  );
  await writeMetadata(`${root}/proof-progress.json`, JSON.stringify(state));
});

const proofFailures: ProofFailure[] = [];

let fixture:
  | {
      readonly restore: () => Promise<void>;
      readonly reload: () => Promise<void>;
    }
  | undefined;

await withProofCleanup(
  async () => {
    await progress.run("namespace", () => {
      requireProof(
        Object.keys(networkInterfaces()).every((name) => name === "lo"),
        "NAMESPACE_NOT_PRIVATE"
      );
    });

    const fs = await runProofEffect(
      FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer))
    );

    const inventory = await progress.run("inventory", async () =>
      Schema.decodeUnknownSync(Schema.fromJsonString(Inventory))(
        await runProofEffect(fs.readFileString(`${root}/inventory.json`))
      )
    );

    const client = await runProofEffect(
      HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
    );

    const read = async (
      url: string,
      init?: {
        readonly method?: "POST";
        readonly headers?: Record<string, string>;
      }
    ): Promise<typeof Schema.Json.Type> => {
      const response = await runProofEffect(
        (init?.method === "POST"
          ? client.post(url)
          : client.get(url, { headers: init?.headers })
        ).pipe(Effect.timeout("60 seconds"))
      );

      if (response.status < 200 || response.status >= 300) {
        const body = await runProofEffect(
          response.json.pipe(Effect.timeout("60 seconds"))
        ).catch(() => null);

        const error = Schema.is(ProtocolErrorBody)(body)
          ? protocolErrorCode(body.error)
          : undefined;

        throw new ProofHttpFailure(
          error === undefined
            ? { status: response.status }
            : { error, status: response.status }
        );
      }

      return Schema.decodeUnknownSync(Schema.Json)(
        await runProofEffect(response.json.pipe(Effect.timeout("60 seconds")))
      );
    };

    const loaded = await progress.run("auth-manifest", async () => {
      const pointer = Schema.decodeUnknownSync(Schema.Struct({ prefix: Text }))(
        await read(`${filerBase}deploy/current.json`)
      );

      const url = `${filerBase}${pointer.prefix}/manifest.json`;
      const original = await read(url);

      return {
        manifest: Schema.decodeUnknownSync(Manifest)(original),
        original,
        url,
      };
    });

    const { bindings } = loaded.manifest.raw_metadata;

    const binding = (name: string): string => {
      const value = bindings.find((entry) => entry.name === name)?.text;

      if (value === undefined) {
        throw new ProofAssertionFailure({ assertionCode: "MISSING_BINDING" });
      }

      return value;
    };

    const put = async (value: typeof Schema.Json.Type): Promise<void> => {
      const response = await runProofEffect(
        client
          .put(loaded.url, { body: HttpBody.jsonUnsafe(value) })
          .pipe(Effect.timeout("60 seconds"))
      );

      if (response.status < 200 || response.status >= 300) {
        throw new ProofHttpFailure({ status: response.status });
      }

      await runProofEffect(
        response.arrayBuffer.pipe(Effect.timeout("60 seconds"))
      );
    };

    const reload = async (): Promise<void> => {
      await read(`${internalBase}/reload`, { method: "POST" });
    };

    fixture = {
      reload,
      restore: async () => {
        await put(loaded.original);
      },
    };
    const probeDid = "did:web:restore-drill.invalid";

    const signingKey = await progress.run("auth-fixture", async () => {
      const keys = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"]
      );

      if (!("publicKey" in keys)) {
        throw new ProofAssertionFailure({ assertionCode: "EXPECTED_KEYPAIR" });
      }

      const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);

      const jwk = Schema.decodeUnknownSync(
        Schema.Struct({ crv: Text, kty: Text, x: Text, y: Text })
      )(exported);

      const originalDocs = Schema.decodeUnknownSync(
        Schema.fromJsonString(Documents)
      )(binding("DID_DOCUMENTS"));

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
        const allowlist = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Array(Text))
        )(binding(name));

        replacements.set(name, JSON.stringify([...allowlist, probeDid]));
      }

      await put({
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
    });

    await progress.run("reload", reload);

    const xrpc = async (
      method: string,
      params: Record<string, string>,
      issuer = probeDid
    ): Promise<typeof Schema.Json.Type> => {
      const now = Math.floor(
        (await runProofEffect(Clock.currentTimeMillis)) / 1000
      );

      const nsid = `sh.mschf.ratking.${method}`;

      const token = await runProofEffect(
        serviceToken(
          {
            aud: `${binding("SERVICE_DID")}#mailbox`,
            exp: now + 60,
            iat: now,
            iss: issuer,
            jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
            lxm: nsid,
          },
          signingKey,
          "#restore-drill"
        )
      );

      return await read(
        `${publicBase}/xrpc/${nsid}?${new URLSearchParams(params).toString()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
    };

    const knownDid = await progress.run("resolve-name", async () => {
      let nameCursor: string | undefined;
      let known: { readonly did: string } | undefined;
      const nameCursors = new Set<string>();

      do {
        const params: NamePageParams = { limit: "100" };

        if (nameCursor !== undefined) {
          params.cursor = nameCursor;
        }

        const result = Schema.decodeUnknownSync(Names)(
          // oxlint-disable-next-line no-await-in-loop -- Pagination requires the preceding response cursor.
          await xrpc("identity.listNames", params)
        );

        known = result.names.find((entry) => entry.name === knownName);

        if (known !== undefined) {
          break;
        }

        ({ cursor: nameCursor } = result);

        if (nameCursor !== undefined) {
          requireProof(!nameCursors.has(nameCursor), "NAME_CURSOR_REPEATED");
          nameCursors.add(nameCursor);
        }
      } while (nameCursor !== undefined);

      return (
        known?.did ??
        binding("ISSUER_DID_TEMPLATE").replace(
          "{agent}",
          knownName.replaceAll("/", ".")
        )
      );
    });

    await progress.run("resolve-lease", async () => {
      try {
        await xrpc("runtime.resolveLease", { did: knownDid });
      } catch (error) {
        const failure = proofFailureMetadata(
          "primary",
          error,
          progress.snapshot()
        );

        if (failure.tag !== "ProofHttpFailure" || failure.status !== 404) {
          throw error;
        }
      }
    });
    let message: (typeof Message.Type & { readonly seq: number }) | undefined;
    const counts: { readonly events: number; readonly messages: number }[] = [];
    const mailboxKeyProofs: (typeof MailboxKeyProof.Type)[] = [];

    const fetchMailbox = async (
      mailbox: (typeof Inventory.Type.mailboxes)[number]
    ) =>
      await progress.run("fetch-events", async () => {
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

          const result = Schema.decodeUnknownSync(Events)(
            // oxlint-disable-next-line no-await-in-loop -- Pagination requires the preceding response cursor; bound scratch load.
            await xrpc("mailbox.list", params, mailbox.did)
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
            requireProof(!cursors.has(cursor), "MAILBOX_CURSOR_REPEATED");
            cursors.add(cursor);
          }
        } while (cursor !== undefined);

        return { admissionEvents, events: count, keys, messages: keys.size };
      });

    for (const [mailboxIndex, mailbox] of inventory.mailboxes.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- Inspect only the selected mailboxes sequentially.
      const counted = await fetchMailbox(mailbox);

      // oxlint-disable-next-line no-await-in-loop -- Compare one selected mailbox before fetching the next.
      await progress.run("compare-counts", () => {
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
          duplicateAdmissionEvents: counted.admissionEvents - counted.messages,
          mailboxIndex,
        });
      });
    }

    await progress.run("message-readback", () => {
      requireProof(message !== undefined, "NEWEST_MESSAGE_MISSING");
    });
    await progress.run("write-proof", async () => {
      await runProofEffect(
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
  },
  async () => {
    const acquired = fixture;

    if (acquired !== undefined) {
      await progress.run("restore-auth", acquired.restore);
      await progress.run("restore-reload", acquired.reload);
    }
  },
  async (failure) => {
    proofFailures.push(failure);
    await runProofEffect(Effect.logError(JSON.stringify(failure)));
    await writeMetadata(
      `${root}/proof-errors.json`,
      JSON.stringify(proofFailures)
    );
  },
  progress.snapshot
).catch(() => {
  process.exitCode = 1;
});
