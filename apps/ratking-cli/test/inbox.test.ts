import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { Inbox, RatKing } from "@rat-king/ratking-client/ratking";
import {
  Console,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { runAction } from "../../../packages/pi-ratking/src/tool.ts";
import { harness } from "../../../packages/pi-ratking/test/harness.ts";
import { runRatking } from "../src/main.ts";
import { Wiring } from "../src/session.ts";
import {
  captured,
  fakeMailbox,
  LEASE_ID,
  mail,
  people,
  seeded,
  socketLayer,
} from "./fixture.ts";

const heldBody = (seq: number) =>
  `message ${seq}\n${"body ".repeat(820)}end ${seq}`;

const State = Schema.Literals(["accepted", "delivered", "acked", "expired"]);

const Document = Schema.Struct({
  error: Schema.optionalKey(
    Schema.Struct({ tag: Schema.String, why: Schema.String })
  ),
  held: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
  messages: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String }))
  ),
  ok: Schema.Boolean,
});

const ReadDocument = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.JsonObject,
    warning: Schema.optionalKey(Schema.String),
  })
);

const WRITES = [
  ".acquireLease",
  ".renewLease",
  ".releaseLease",
  ".deliver",
  ".ack",
  ".send",
];

const writes = (calls: readonly { readonly nsid: string }[]) =>
  calls.filter((call) => WRITES.some((write) => call.nsid.endsWith(write)));

it.live(
  "read preserves its JSON contract and falls back when ack was not confirmed; delegated and settled holds succeed",
  () =>
    Effect.forEach(
      ["corrupt", "refused", "expired", "delegated", "settled"] as const,
      (mode) =>
        Effect.gen(function* readAfterFailure() {
          const fs = yield* FileSystem.FileSystem;
          const state = yield* fs.makeTempDirectoryScoped();
          const who = yield* people;

          const original = yield* mail(who, 1, "accepted", {
            body: "recoverable from server",
          });

          const entry =
            mode === "delegated"
              ? {
                  ...original,
                  event: {
                    ...original.event,
                    receipt: {
                      ...original.event.receipt,
                      delegatedTo: who.peer.did,
                    },
                  },
                }
              : original;

          const id = entry.event.receipt.message.messageId;
          const fake = fakeMailbox([entry]);

          const http = HttpClient.make((request) => {
            if (!new URL(request.url).pathname.endsWith(".ack")) {
              return fake.http.execute(request);
            }

            const response =
              mode === "expired"
                ? Response.json({
                    receipt: { ...entry.event.receipt, state: "expired" },
                  })
                : Response.json(
                    mode === "settled"
                      ? {
                          error: "InvalidTransition",
                          message: "Message already settled",
                        }
                      : { error: "LeaseMismatch", message: "Lease changed" },
                    { status: 409 }
                  );

            return Effect.succeed(
              HttpClientResponse.fromWeb(request, response)
            );
          });

          const wiring = harness(state, http, [], {
            secrets: seeded(who),
          }).pipe(Layer.provideMerge(socketLayer));

          yield* Directory.use((directory) =>
            directory.record("peer", who.peerDocument)
          ).pipe(Effect.provide(wiring));

          if (mode === "corrupt") {
            yield* fs.makeDirectory(`${state}/received-mail`, {
              recursive: true,
            });
            yield* fs.writeFileString(
              `${state}/received-mail/tester.json`,
              "{"
            );
          } else {
            const held = yield* Effect.gen(function* tryHold() {
              const inbox = yield* Inbox;
              yield* inbox.attach("tester");

              return yield* inbox.hold((_entry, ack) => ack, {
                session: "tester-cli",
              });
            }).pipe(Effect.provide(wiring), Effect.result);

            expect(held._tag).toBe(
              mode === "delegated" || mode === "settled" ? "Success" : "Failure"
            );
          }

          const out = captured();
          yield* runRatking(["read", id, "--as", "tester", "--json"]).pipe(
            Effect.provideService(Console.Console, out.console),
            Effect.provideService(Wiring, wiring)
          );

          const document = yield* Schema.decodeEffect(ReadDocument)(
            out.stdout.join("\n")
          );

          expect(document.message).toEqual({
            body: "recoverable from server",
            carbonCopy: false,
            cc: [],
            did: who.peer.did,
            encrypted: false,
            from: "peer",
            id,
            kind: "message",
            label: null,
            redelivered: mode !== "corrupt",
            replyTo: null,
            seq: 1,
            state: mode === "corrupt" ? "accepted" : "delivered",
            summary: null,
            thread: id,
            to: "tester",
            verified: true,
          });
          expect(
            document.warning?.includes("local received mail journal") ?? false
          ).toBe(mode === "corrupt");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { discard: true }
    ),
  { timeout: 30_000 }
);

it.live.prop(
  "the CLI projects the Pi's staged plaintext with receipt metadata and refreshes unacked custody",
  [Schema.Literals(["acked", "expired"])],
  ([outcome]) =>
    Effect.gen(function* piReadback() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const who = yield* people;
      const body = "x".repeat(4100);

      const entry = yield* mail(who, 1, "accepted", {
        body,
        cc: ["tester"],
        to: "other",
      });

      const id = entry.event.receipt.message.messageId;
      const fake = fakeMailbox([entry]);

      const wiring = harness(state, fake.http, [], {
        secrets: seeded(who),
      }).pipe(Layer.provideMerge(socketLayer));

      yield* fs.makeDirectory(`${state}/cursors`, { recursive: true });
      yield* fs.writeFileString(
        `${state}/cursors/tester.json`,
        JSON.stringify({ afterSeq: 0 })
      );

      const read = (receipt: "delivered" | "acked" | "expired") =>
        Effect.gen(function* readTheJournal() {
          const cli = captured();
          yield* runRatking(["read", id, "--as", "tester", "--json"]).pipe(
            Effect.provideService(Console.Console, cli.console),
            Effect.provideService(Wiring, wiring)
          );

          const doc = yield* Schema.decodeEffect(ReadDocument)(
            cli.stdout.join("\n")
          );

          expect(doc.message).toEqual({
            ...(receipt === "expired" ? { ackOutcome: "expired" } : undefined),
            body,
            carbonCopy: true,
            cc: ["tester"],
            did: who.peer.did,
            encrypted: false,
            from: "peer",
            id,
            kind: "message",
            label: null,
            redelivered: receipt === "delivered",
            replyTo: null,
            seq: 1,
            state: receipt,
            summary: null,
            thread: id,
            to: "other",
            verified: true,
          });
        });

      yield* Effect.gen(function* piReader() {
        const king = yield* RatKing;
        const shown = yield* Deferred.make<Effect.Effect<void>>();
        yield* Directory.use((directory) =>
          directory.record("peer", who.peerDocument)
        );
        yield* king.run(
          {
            alive: () => true,
            env: Option.some("tester"),
            pane: Option.none(),
            pid: 1,
            session: "tester-pi",
          },
          (inbound, _settled, ack, canRead) =>
            Effect.sync(() => {
              expect(inbound.id).toBe(id);
              expect(canRead?.()).toBe(true);
            }).pipe(
              Effect.andThen(
                Deferred.succeed(
                  shown,
                  ack ?? Effect.die("Missing display acknowledgment")
                )
              ),
              Effect.asVoid
            )
        );

        const ack = yield* Deferred.await(shown).pipe(
          Effect.timeout("5 seconds")
        );

        yield* read("delivered");
        const pi = yield* runAction("ratking", 1, { action: "read", id });
        expect(pi.text).toContain(body);

        if (outcome === "expired") {
          entry.state = "expired";
        }

        yield* ack;
        yield* read(outcome);
      }).pipe(Effect.provide(wiring));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 }, timeout: 30_000 }
);

const exitCode = Effect.sync(() => {
  const { exitCode: code } = process;
  process.exitCode = undefined;

  return code;
});

it.live.prop(
  "inbox without --hold lists exactly the unsettled mail and writes nothing to the mailbox: no lease, no deliver, no ack",
  [Schema.Array(State).check(Schema.isMaxLength(5))],
  ([states]) =>
    Effect.gen(function* peekProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const who = yield* people;

      const mails = yield* Effect.forEach(
        states.map((status, index) => ({ index, status })),
        ({ index, status }) =>
          mail(who, index + 1, status, {
            body: `message ${index}`,
            cc: [],
            thread: `thread-${index}`,
          })
      );

      const fake = fakeMailbox(mails);
      const out = captured();
      const wiring = harness(state, fake.http, [], { secrets: seeded(who) });

      yield* Directory.use((directory) =>
        directory.record("peer", who.peerDocument)
      ).pipe(Effect.provide(wiring));

      yield* runRatking(["inbox", "--as", "tester", "--json"]).pipe(
        Effect.provideService(Console.Console, out.console),
        Effect.provideService(Wiring, wiring)
      );

      const document = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Document)
      )(out.stdout.join("\n"));

      expect(document.ok).toBe(true);

      expect(document.messages?.map((message) => message.id)).toEqual(
        mails
          .filter(
            (entry) => entry.state === "accepted" || entry.state === "delivered"
          )
          .map((entry) => entry.event.receipt.message.messageId)
      );

      expect(writes(fake.calls)).toEqual([]);
      expect(mails.map((entry) => entry.state)).toEqual([...states]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 }, timeout: 120_000 }
);

it.live(
  "inbox --hold refuses LeaseHeld naming the live holder's session and takes nothing: no acquire granted, no deliver, no ack, the holder's lease untouched",
  () =>
    Effect.gen(function* refusalProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const who = yield* people;

      const mails = yield* Effect.forEach([1, 2], (seq) =>
        mail(who, seq, "accepted", {
          body: `message ${seq}`,
          cc: [],
          thread: `thread-${seq}`,
        })
      );

      const holder = {
        did: who.tester.did,
        expiresAt: "2099-01-01T00:00:00.000Z",
        generation: 7,
        harness: {
          $type: "sh.mschf.ratking.runtime.lease#pi",
          sessionId: "pi-session-live",
        },
        leaseId: LEASE_ID,
      };

      const fake = fakeMailbox(mails, holder);
      const out = captured();

      const wiring = harness(state, fake.http, [], {
        secrets: seeded(who),
      }).pipe(Layer.provideMerge(socketLayer));

      yield* Directory.use((directory) =>
        directory.record("peer", who.peerDocument)
      ).pipe(Effect.provide(wiring));

      yield* runRatking(["inbox", "--as", "tester", "--hold", "--json"]).pipe(
        Effect.provideService(Console.Console, out.console),
        Effect.provideService(Wiring, wiring),
        Effect.timeout("5 seconds")
      );

      const document = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Document)
      )(out.stdout.join("\n"));

      expect(document.ok).toBe(false);
      expect(document.error?.tag).toBe("LeaseHeld");
      expect(document.error?.why).toContain("pi-session-live");
      expect(yield* exitCode).toBe(4);
      expect(fake.lease()).toEqual(holder);

      expect(
        writes(fake.calls).filter(
          (call) => !call.nsid.endsWith(".acquireLease")
        )
      ).toEqual([]);

      expect(mails.map((entry) => entry.state)).toEqual([
        "accepted",
        "accepted",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 60_000 }
);

it.live.prop(
  "inbox --hold on a free lease delivers every unsettled message once, acks each only after it was shown, and releases the lease",
  [Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 }))],
  ([count]) =>
    Effect.gen(function* holdProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const who = yield* people;

      const mails = yield* Effect.forEach(
        Array.from({ length: count }, (_, index) => index + 1),
        (seq) =>
          mail(who, seq, "accepted", {
            body: heldBody(seq),
            cc: [],
            thread: `thread-${seq}`,
          })
      );

      const fake = fakeMailbox(mails);
      const shown: string[] = [];

      const out = captured((line) => {
        shown.push(
          `${line}|${fake.calls.filter((call) => call.nsid.endsWith(".ack")).length}`
        );
      });

      const wiring = harness(state, fake.http, [], {
        secrets: seeded(who),
      }).pipe(Layer.provideMerge(socketLayer));

      yield* Directory.use((directory) =>
        directory.record("peer", who.peerDocument)
      ).pipe(Effect.provide(wiring));

      yield* runRatking(["inbox", "--as", "tester", "--hold"]).pipe(
        Effect.provideService(Console.Console, out.console),
        Effect.provideService(Wiring, wiring),
        Effect.timeout("20 seconds")
      );

      const nsids = fake.calls.map((call) => call.nsid.split(".").at(-1));

      expect(mails.map((entry) => entry.state)).toEqual(
        mails.map(() => "acked")
      );
      expect(nsids.filter((nsid) => nsid === "deliver")).toHaveLength(count);
      expect(nsids.filter((nsid) => nsid === "ack")).toHaveLength(count);
      expect(nsids.at(-1)).toBe("releaseLease");
      expect(fake.lease()).toBeUndefined();

      const lines = shown.filter((line) => line.startsWith("🐀 from"));

      expect(lines.map((line) => line.split("|")[1])).toEqual(
        lines.map((_, index) => String(index))
      );

      const last = mails.length;
      const id = mails.at(-1)?.event.receipt.message.messageId ?? "missing";
      const read = captured();
      const beforeRead = fake.calls.length;

      yield* runRatking(["read", id, "--as", "tester"]).pipe(
        Effect.provideService(Console.Console, read.console),
        Effect.provideService(Wiring, wiring)
      );

      expect(read.stdout.join("\n")).toContain(heldBody(last));

      const result = yield* Effect.gen(function* readInPi() {
        yield* Inbox.use((inbox) => inbox.attach("tester"));

        return yield* runAction("ratking", "5 seconds", { action: "read", id });
      }).pipe(Effect.provide(wiring));

      expect(result.isError).toBe(false);
      expect(result.text).toBe(heldBody(last));
      expect(
        fake.calls
          .slice(beforeRead)
          .filter(({ nsid }) => nsid.endsWith(".poll"))
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 120_000 }
);
