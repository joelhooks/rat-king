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

type NamePageParams = Record<string, string> & {
  cursor?: string;
  limit: string;
};

type MailboxPageParams = NamePageParams & {
  recipientDid: string;
};

const Text = Schema.NonEmptyString;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Message = Schema.Struct({
  messageId: Text,
  recipientDid: Text,
  senderDid: Text,
});

const Inventory = Schema.Struct({
  mailboxes: Schema.Array(
    Schema.Struct({ did: Text, events: Count, messages: Count })
  ),
  newest: Message,
});

const Rest = [Schema.Record(Schema.String, Schema.Json)];

const Binding = Schema.StructWithRest(
  Schema.Struct({
    name: Text,
    text: Schema.optionalKey(Schema.String),
  }),
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

const requireProof = (condition: boolean, reason: string): void => {
  if (!condition) {
    throw new Error(reason);
  }
};

requireProof(
  Object.keys(networkInterfaces()).every((name) => name === "lo"),
  "Private loopback namespace required"
);

const fs = await Effect.runPromise(
  FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer))
);

const client = await Effect.runPromise(
  HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
);

const inventory = Schema.decodeUnknownSync(Schema.fromJsonString(Inventory))(
  await Effect.runPromise(fs.readFileString(`${root}/inventory.json`))
);

const read = async (
  url: string,
  init?: { readonly method?: "POST"; readonly headers?: Record<string, string> }
): Promise<typeof Schema.Json.Type> => {
  const response = await Effect.runPromise(
    (init?.method === "POST"
      ? client.post(url)
      : client.get(url, { headers: init?.headers })
    ).pipe(Effect.timeout("60 seconds"))
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Scratch HTTP ${response.status} ${new URL(url).pathname}`);
  }

  return Schema.decodeUnknownSync(Schema.Json)(
    await Effect.runPromise(response.json.pipe(Effect.timeout("60 seconds")))
  );
};

const pointer = Schema.decodeUnknownSync(Schema.Struct({ prefix: Text }))(
  await read(`${filerBase}deploy/current.json`)
);

const manifestUrl = `${filerBase}${pointer.prefix}/manifest.json`;

const original = await read(manifestUrl);

const manifest = Schema.decodeUnknownSync(Manifest)(original);

const { bindings } = manifest.raw_metadata;

const binding = (name: string): string => {
  const value = bindings.find((entry) => entry.name === name)?.text;

  if (value === undefined) {
    throw new Error(`Missing restored binding ${name}`);
  }

  return value;
};

const probeDid = "did:web:restore-drill.invalid";

const keys = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

if (!("publicKey" in keys)) {
  throw new Error("Expected an ephemeral signing key pair");
}

const { publicKey, privateKey } = keys;

const exported = await crypto.subtle.exportKey("jwk", publicKey);

const jwk = Schema.decodeUnknownSync(
  Schema.Struct({ crv: Text, kty: Text, x: Text, y: Text })
)(exported);

const originalDocs = Schema.decodeUnknownSync(Schema.fromJsonString(Documents))(
  binding("DID_DOCUMENTS")
);

const recipientDids = new Set([
  probeDid,
  ...inventory.mailboxes.map((mailbox) => mailbox.did),
]);

const documents = originalDocs.filter((doc) => !recipientDids.has(doc.id));

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

const patched = {
  ...manifest,
  raw_metadata: {
    ...manifest.raw_metadata,
    bindings: bindings.map((entry) => {
      const text = replacements.get(entry.name);

      return text === undefined ? entry : { ...entry, text };
    }),
  },
};

const put = async (value: typeof Schema.Json.Type): Promise<void> => {
  const response = await Effect.runPromise(
    client
      .put(manifestUrl, { body: HttpBody.jsonUnsafe(value) })
      .pipe(Effect.timeout("60 seconds"))
  );

  requireProof(
    response.status >= 200 && response.status < 300,
    `Scratch auth fixture HTTP ${response.status}`
  );
  await Effect.runPromise(
    response.arrayBuffer.pipe(Effect.timeout("60 seconds"))
  );
};

const reload = async () =>
  await read(`${internalBase}/reload`, { method: "POST" });

const xrpc = async (
  method: string,
  params: Record<string, string>,
  issuer = probeDid
): Promise<typeof Schema.Json.Type> => {
  const now = Math.floor(
    (await Effect.runPromise(Clock.currentTimeMillis)) / 1000
  );

  const nsid = `sh.mschf.ratking.${method}`;

  const token = await Effect.runPromise(
    serviceToken(
      {
        aud: `${binding("SERVICE_DID")}#mailbox`,
        exp: now + 60,
        iat: now,
        iss: issuer,
        jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
        lxm: nsid,
      },
      privateKey,
      "#restore-drill"
    )
  );

  return await read(
    `${publicBase}/xrpc/${nsid}?${new URLSearchParams(params).toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
};

try {
  await put(patched);
  await reload();
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
      requireProof(!nameCursors.has(nameCursor), "Repeated name cursor");
      nameCursors.add(nameCursor);
    }
  } while (nameCursor !== undefined);

  const knownDid =
    known?.did ??
    binding("ISSUER_DID_TEMPLATE").replace(
      "{agent}",
      knownName.replaceAll("/", ".")
    );

  try {
    await xrpc("runtime.resolveLease", { did: knownDid });
  } catch (error) {
    requireProof(
      error instanceof Error &&
        error.message ===
          "Scratch HTTP 404 /xrpc/sh.mschf.ratking.runtime.resolveLease",
      String(error)
    );
  }

  let message: (typeof Message.Type & { readonly seq: number }) | undefined;
  const counts: { readonly events: number; readonly messages: number }[] = [];

  for (const mailbox of inventory.mailboxes) {
    let cursor: string | undefined;
    let count = 0;
    let messages = 0;
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
          messages += 1;

          if (
            mailbox.did === inventory.newest.recipientDid &&
            event.envelope.aad.messageId === inventory.newest.messageId &&
            event.envelope.aad.senderDid === inventory.newest.senderDid
          ) {
            message = { ...inventory.newest, seq: event.seq };
          }
        }
      }

      ({ cursor } = result);

      if (cursor !== undefined) {
        requireProof(!cursors.has(cursor), "Repeated mailbox cursor");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);

    requireProof(count === mailbox.events, "Restored event count mismatch");
    requireProof(
      messages === mailbox.messages,
      "Restored message count mismatch"
    );
    counts.push({ events: count, messages });
  }

  requireProof(
    message !== undefined,
    "Newest restored message absent from API"
  );
  await Effect.runPromise(
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
        message,
      }),
      { mode: 0o600 }
    )
  );
} finally {
  await put(original);
  await reload();
}
