import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import { PayloadJson } from "@rat-king/ratking-client/payload";
import type { PayloadValue } from "@rat-king/ratking-client/payload";
import type { Console } from "effect";
import { Clock, DateTime, Effect, Layer, Predicate, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";

import { WebSocketPort } from "../../../packages/mailbox-client/src/watch.ts";
import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";

export const ENDPOINT = "https://mailbox.example.invalid";

export const SERVICE = "did:web:mailbox.example.invalid";

export const TESTER = "did:web:tester.agents.example.invalid";

export const PEER = "did:web:peer.agents.example.invalid";

export const LEASE_ID = "3mxcx45mn7sex";

export interface FakeLease {
  readonly did: string;
  readonly expiresAt: string;
  readonly generation: number;
  readonly harness: Schema.Json;
  readonly leaseId: string;
}

export interface Call {
  readonly body: Schema.Json;
  readonly nsid: string;
}

export interface Mail {
  readonly event: Defs.MessageEventValue;
  state: string;
}

export const people = Effect.gen(function* people() {
  const tester = yield* identity(TESTER);
  const peer = yield* identity(PEER);
  const other = yield* identity("did:web:other.agents.example.invalid");

  return {
    other,
    otherDocument: yield* document(other),
    peer,
    peerDocument: yield* document(peer),
    tester,
    testerDocument: yield* document(tester),
  };
});

export type People = Effect.Success<typeof people>;

export const mail = Effect.fn("Fixture.mail")(
  function* mail(
    who: People,
    seq: number,
    state: string,
    payload: Omit<PayloadValue, "from" | "to">
  ) {
    const client = yield* prepare({
      endpoint: ENDPOINT,
      own: yield* ownIdentity(who.peer),
      peers: [who.testerDocument],
      serviceDid: SERVICE,
    });

    const text = yield* Schema.encodeEffect(PayloadJson)({
      ...payload,
      from: "peer",
      to: "tester",
    });

    const envelope = yield* client.seal(TESTER, text, { encrypt: false });

    const event = yield* Schema.decodeUnknownEffect(
      Schema.toType(Defs.MessageEvent)
    )({
      $type: "sh.mschf.ratking.defs#messageEvent",
      envelope,
      receipt: {
        message: {
          messageId: envelope.aad.messageId,
          senderDid: envelope.aad.senderDid,
        },
        recipientDid: TESTER,
        seq,
        state,
      },
      seq,
    });

    return { event, state } satisfies Mail;
  },
  Effect.scoped,
  Effect.provide(FetchHttpClient.layer)
);

const receiptOf = (entry: Mail) => ({
  ...entry.event.receipt,
  state: entry.state,
});

const Fenced = Schema.Struct({
  did: Schema.String,
  harness: Schema.Json,
  leaseId: Schema.optionalKey(Schema.String),
});

const Referenced = Schema.Struct({
  message: Schema.Struct({ messageId: Schema.String }),
});

const Sent = Schema.Struct({
  envelope: Defs.EncryptedEnvelope,
  generation: Schema.optionalKey(Schema.Int),
  leaseId: Schema.optionalKey(Schema.String),
});

const textOf = (request: HttpClientRequest.HttpClientRequest) =>
  Predicate.isTagged(request.body, "Uint8Array")
    ? new TextDecoder().decode(request.body.body)
    : "{}";

export interface FakeAttention {
  prefs: Schema.Json;
  status: Schema.Json;
}

export const quietAttention = (): FakeAttention => ({
  prefs: {
    allow: [],
    forward: [],
    log: false,
    model: { body: "summary", kind: "none", timeoutMs: 30_000 },
    mute: [],
    refuse: [],
    version: "0.1",
  },
  status: {
    $type: "sh.mschf.ratking.attention.status",
    state: "available",
    version: "0.1",
  },
});

export interface FakeIssuer {
  readonly roles?: readonly Schema.Json[];
  readonly routes?: ReadonlyMap<
    string,
    { readonly status: number; readonly body: Schema.Json }
  >;
}

const ROLE_PAGE = 2;

const unavailable = { body: { error: "MailboxUnavailable" }, status: 503 };

const issuerAnswer = (issuer: FakeIssuer, nsid: string, url: URL) => {
  if (nsid.endsWith(".resolveRecipient")) {
    return (
      issuer.routes?.get(url.searchParams.get("name") ?? "") ?? unavailable
    );
  }

  if (!nsid.endsWith(".listRoles") || issuer.roles === undefined) {
    return unavailable;
  }

  const start = Number(url.searchParams.get("cursor") ?? 0);
  const roles = issuer.roles.slice(start, start + ROLE_PAGE);

  return {
    body:
      start + ROLE_PAGE < issuer.roles.length
        ? { cursor: String(start + ROLE_PAGE), roles }
        : { roles },
    status: 200,
  };
};

export const fakeMailbox = (
  mails: readonly Mail[],
  held?: FakeLease,
  attention: FakeAttention = quietAttention(),
  issuer: FakeIssuer = {}
) => {
  const calls: Call[] = [];
  const sends: Defs.EncryptedEnvelopeValue[] = [];
  let lease = held;

  const listing = (after: number) =>
    Schema.decodeUnknownEffect(Schema.toType(List.Output))({
      events: mails.flatMap((entry) =>
        entry.event.seq > after
          ? [{ ...entry.event, receipt: receiptOf(entry) }]
          : []
      ),
      throughSeq: Math.max(0, ...mails.map((entry) => entry.event.seq)),
    }).pipe(Effect.flatMap(Schema.encodeEffect(List.Output)));

  const acquisition = (text: string, now: number) =>
    Effect.gen(function* acquire() {
      const input = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Fenced)
      )(text);

      const resumes = input.leaseId === lease?.leaseId;

      if (
        lease !== undefined &&
        Date.parse(lease.expiresAt) > now &&
        !resumes
      ) {
        return {
          body: { error: "LeaseHeld", message: "Lease is held" },
          status: 409,
        };
      }

      lease = {
        did: input.did,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 300_000)),
        generation: resumes
          ? (lease?.generation ?? 1)
          : (lease?.generation ?? 0) + 1,
        harness: input.harness,
        leaseId: LEASE_ID,
      };

      return { body: { lease }, status: 200 };
    });

  const settlement = (text: string, state: string) =>
    Effect.gen(function* settle() {
      const input = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Referenced)
      )(text);

      const entry = mails.find(
        (candidate) =>
          candidate.event.receipt.message.messageId === input.message.messageId
      );

      if (entry === undefined) {
        return { body: { error: "MessageNotFound" }, status: 404 };
      }

      entry.state = state;

      return { body: { receipt: receiptOf(entry) }, status: 200 };
    });

  const admission = (text: string, now: number) =>
    Effect.gen(function* admit() {
      const sent = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Sent)
      )(text);

      const live = lease !== undefined && Date.parse(lease.expiresAt) > now;

      const fenced =
        sent.leaseId !== undefined || sent.generation !== undefined;

      if (
        (live || fenced) &&
        !(
          live &&
          sent.leaseId === lease?.leaseId &&
          sent.generation === lease?.generation
        )
      ) {
        return {
          body: { error: "LeaseMismatch", message: "Send fence refused" },
          status: 409,
        };
      }

      sends.push(sent.envelope);

      return {
        body: {
          receipt: {
            message: {
              messageId: sent.envelope.aad.messageId,
              senderDid: sent.envelope.aad.senderDid,
            },
            recipientDid: sent.envelope.aad.recipientDid,
            seq: sends.length,
            state: "accepted",
          },
        },
        status: 200,
      };
    });

  const answer = (nsid: string, url: URL, text: string) =>
    Effect.gen(function* route() {
      const now = yield* Clock.currentTimeMillis;

      if (nsid.endsWith(".list")) {
        return {
          body: yield* listing(Number(url.searchParams.get("afterSeq") ?? 0)),
          status: 200,
        };
      }

      if (nsid.endsWith(".resolveLease")) {
        return lease === undefined
          ? { body: { error: "LeaseNotFound" }, status: 404 }
          : { body: { lease }, status: 200 };
      }

      if (nsid.endsWith(".acquireLease")) {
        return yield* acquisition(text, now);
      }

      if (nsid.endsWith(".releaseLease")) {
        lease = undefined;

        return { body: { released: true }, status: 200 };
      }

      if (nsid.endsWith(".deliver") || nsid.endsWith(".ack")) {
        return yield* settlement(
          text,
          nsid.endsWith(".ack") ? "acked" : "delivered"
        );
      }

      if (nsid.endsWith(".send")) {
        return yield* admission(text, now);
      }

      if (nsid.includes(".identity.")) {
        return issuerAnswer(issuer, nsid, url);
      }

      if (nsid.endsWith("attention.getPreferences")) {
        return { body: { prefs: attention.prefs }, status: 200 };
      }

      if (nsid.endsWith("attention.getStatus")) {
        return { body: { status: attention.status }, status: 200 };
      }

      if (nsid.endsWith("attention.putPreferences")) {
        const input = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ prefs: Schema.Json }))
        )(text);

        attention.prefs = input.prefs;

        return { body: { prefs: attention.prefs }, status: 200 };
      }

      if (nsid.endsWith("attention.putStatus")) {
        const input = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ status: Schema.Json }))
        )(text);

        attention.status = input.status;

        return { body: { status: attention.status }, status: 200 };
      }

      return { body: { error: "MailboxUnavailable" }, status: 503 };
    });

  const http = HttpClient.make((request) =>
    Effect.gen(function* mailbox() {
      const url = new URL(request.url);
      const nsid = url.pathname.replace("/xrpc/", "");
      const text = textOf(request);

      calls.push({
        body: yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Json)
        )(text),
        nsid,
      });

      const { body, status } = yield* answer(nsid, url, text);

      return HttpClientResponse.fromWeb(
        request,
        Response.json(body, { status })
      );
    }).pipe(Effect.orDie)
  );

  return { attention, calls, http, lease: () => lease, sends };
};

export interface Captured {
  readonly stderr: string[];
  readonly stdout: string[];
}

export const captured = (
  observe?: (line: string) => void
): Captured & {
  readonly console: Console.Console;
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    console: {
      ...console,
      error: (...parts: readonly unknown[]) => {
        stderr.push(parts.join(" "));
      },
      log: (...parts: readonly unknown[]) => {
        observe?.(parts.join(" "));
        stdout.push(parts.join(" "));
      },
    },
    stderr,
    stdout,
  };
};

export const socketLayer = Layer.succeed(WebSocketPort, {
  connect: () => {
    const target = new EventTarget();

    return {
      addEventListener: (type, listener, options) => {
        target.addEventListener(type, listener, options);
      },
      close: () => {
        target.dispatchEvent(new Event("close"));
      },
      readyState: 1,
      removeEventListener: (type, listener) => {
        target.removeEventListener(type, listener);
      },
      send: () => {
        queueMicrotask(() => {
          target.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify({ seq: 1 }) })
          );
        });
      },
    };
  },
});

export const SECRET = "rat_king_fleet_agent_tester_identity";

export const seeded = (who: People) =>
  new Map([[SECRET, JSON.stringify(who.tester)]]);
