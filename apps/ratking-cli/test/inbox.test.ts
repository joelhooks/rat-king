import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { Inbox } from "@rat-king/ratking-client/ratking";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
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
            body: `message ${seq}`,
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

      expect(read.stdout.join("\n")).toContain(`message ${last}`);

      const result = yield* Effect.gen(function* readInPi() {
        yield* Inbox.use((inbox) => inbox.attach("tester"));

        return yield* runAction("ratking", "5 seconds", { action: "read", id });
      }).pipe(Effect.provide(wiring));

      expect(result.isError).toBe(false);
      expect(result.text).toBe(`message ${last}`);
      expect(
        fake.calls
          .slice(beforeRead)
          .filter(({ nsid }) => nsid.endsWith(".poll"))
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 120_000 }
);
