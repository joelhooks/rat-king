import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { Directory } from "@rat-king/ratking-client/directory";
import { secretName } from "@rat-king/ratking-client/name";
import {
  markVia,
  RatKing,
  ReaderState,
} from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  ConfigProvider,
  Duration,
  Effect,
  FileSystem,
  Path,
  Match,
  Option,
  Predicate,
  Result,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { collectFacts } from "../src/extension.ts";
import type { NameEntryValue } from "../src/name.ts";
import { harness } from "./harness.ts";

const DESK = "desk";

const DESK_KEY = secretName(DESK);

const facts = {
  alive: () => false,
  env: Option.none<string>(),
  nameless: true,
  pane: Option.none<string>(),
  pid: 1,
  session: "nameless-session",
};

const Env = Schema.Struct({
  RATKING_NAME: Schema.optionalKey(Schema.Literal("alpha")),
  RATKING_PRINT_NAME: Schema.optionalKey(Schema.Literal("beta")),
});

it.effect.prop(
  "only interactive Pis auto-name; headless Pis still need an explicit setting",
  [Arbitrary.schema(Env), Arbitrary.schema(Schema.Boolean)],
  ([env, interactive]) =>
    Effect.gen(function* proof() {
      const explicit = interactive ? env.RATKING_NAME : env.RATKING_PRINT_NAME;

      const collected = yield* collectFacts(
        "any-session",
        undefined,
        interactive,
        []
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...env } }))
        )
      );

      expect(collected.nameless).toBe(!interactive && explicit === undefined);
      expect(Option.getOrUndefined(collected.env)).toBe(
        explicit ?? (interactive ? "pi-any-sess" : undefined)
      );
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "a session that already holds a default name keeps it",
  [Arbitrary.schema(Schema.Boolean)],
  ([interactive]) =>
    Effect.gen(function* proof() {
      const entries: NameEntryValue[] = [
        { name: "pi-live", session: "old-session", source: "default" },
      ];

      const collected = yield* collectFacts(
        "old-session",
        undefined,
        interactive,
        entries
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))
        )
      );

      expect(collected.nameless).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer))
);

const SESSION = "0123456789abcdef";

const VIA = "lane (01234567)";

const LABELLED = { ...facts, session: SESSION, via: () => VIA };

interface Wire {
  readonly calls: string[];
  readonly envelopes: Defs.EncryptedEnvelopeValue[];
}

const mailbox = (wire: Wire) =>
  HttpClient.make((request) =>
    Effect.gen(function* fakeMailbox() {
      wire.calls.push(request.url);

      if (
        !request.url.endsWith("sh.mschf.ratking.mailbox.send") ||
        !Predicate.isTagged(request.body, "Uint8Array")
      ) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "MailboxUnavailable" }, { status: 503 })
        );
      }

      const input = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ envelope: Defs.EncryptedEnvelope })
        )
      )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

      wire.envelopes.push(input.envelope);

      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          receipt: {
            message: {
              messageId: input.envelope.aad.messageId,
              senderDid: input.envelope.aad.senderDid,
            },
            recipientDid: input.envelope.aad.recipientDid,
            seq: wire.envelopes.length,
            state: "accepted",
          },
        })
      );
    })
  );

const SUMMARY = Schema.String.check(Schema.isPattern(/^[a-z]{1,40}$/u));

class CountingKeys extends Map<string, string> {
  leases = 0;

  override get(key: string) {
    this.leases += 1;

    return super.get(key);
  }
}

it.live.prop(
  "a nameless Pi mints and registers nothing and never leases a key; every send, record, ask, reply and handled refuses in three parts without touching the mailbox, whatever its owner and the keys on this machine",
  [
    Arbitrary.schema(Schema.Boolean),
    Arbitrary.schema(Schema.Boolean),
    Arbitrary.schema(
      Schema.Literals(["send", "record", "ask", "ask-kind", "reply", "handled"])
    ),
  ],
  ([hasOwner, holdsKey, action]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const store = new CountingKeys();
      const wire: Wire = { calls: [], envelopes: [] };

      const deskIdentity = yield* identity(
        "did:web:desk.agents.example.invalid"
      );

      if (holdsKey) {
        store.set(DESK_KEY, JSON.stringify(deskIdentity));
      }

      const before = new Map(store);

      yield* Effect.gen(function* run() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;

        yield* directory.record(DESK, yield* document(deskIdentity));

        const registered = (yield* directory.list).length;

        yield* ratking.run(
          {
            ...LABELLED,
            owner: hasOwner ? Option.some(DESK) : Option.none<string>(),
          },
          () => Effect.void
        );

        const failure = yield* Match.value(action).pipe(
          Match.when("send", () => ratking.send(DESK, "hi")),
          Match.when("record", () =>
            ratking.send(DESK, { $type: "example.invalid#record" })
          ),
          Match.when("ask", () => ratking.ask(DESK, "q")),
          Match.when("ask-kind", () =>
            ratking.send(DESK, "q", { kind: "ask" })
          ),
          Match.when("reply", () => ratking.reply("some-id", "a")),
          Match.orElse(() => ratking.handled("some-id")),
          Effect.flip,
          Effect.timeout(Duration.seconds(10))
        );

        const reason = Schema.is(Schema.Struct({ reason: Schema.String }))(
          failure
        )
          ? failure.reason
          : "";

        const status = yield* ratking.status.pipe(
          Effect.filterOrFail(({ reader }) =>
            ReaderState.$is("Refused")(reader)
          ),
          Effect.retry(
            Schedule.spaced("20 millis").pipe(
              Schedule.while(({ attempt }) => attempt < 200)
            )
          )
        );

        expect(reason).toContain("no Rat King name");
        expect(reason).toContain("dead mailboxes");
        expect(reason).toContain("never hold their desk's key");
        expect(reason).toContain("RATKING_PRINT_NAME");
        expect(ReaderState.$is("Refused")(status.reader)).toBe(true);
        expect(Option.isNone(status.self)).toBe(true);
        expect(wire.calls).toEqual([]);
        expect(store.leases).toBe(0);
        expect(new Map(store)).toEqual(before);
        expect((yield* directory.list).length).toBe(registered);
      }).pipe(
        Effect.provide(harness(state, mailbox(wire), [], { secrets: store })),
        Effect.scoped
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 24 }, timeout: 120_000 }
);

it.effect.prop(
  "the via marker prefixes body and summary of text and refuses records",
  [Arbitrary.schema(SUMMARY), Arbitrary.schema(SUMMARY)],
  ([text, summary]) =>
    Effect.sync(() => {
      const marked = markVia(VIA, text, { summary });

      expect(Result.isSuccess(marked)).toBe(true);
      expect(Result.getOrUndefined(marked)).toEqual({
        body: `↳ via headless Pi ${VIA}\n\n${text}`,
        options: { summary: `via lane · ${summary}` },
      });
      expect(
        Result.isFailure(markVia(VIA, { $type: "example.invalid#record" }))
      ).toBe(true);
    })
);

it.effect.prop(
  "the via label is the session name, else the cwd basename, then the first 8 characters of the session id",
  [Arbitrary.schema(Schema.Option(SUMMARY))],
  ([name]) =>
    Effect.gen(function* viaLabel() {
      const collected = yield* collectFacts(
        "0123456789abcdef",
        () => Option.getOrUndefined(name),
        false,
        []
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))
        )
      );

      const path = yield* Path.Path;

      expect(collected.via?.()).toBe(
        `${Option.getOrElse(name, () => path.basename(process.cwd()))} (01234567)`
      );
    }).pipe(Effect.provide(NodeServices.layer))
);
