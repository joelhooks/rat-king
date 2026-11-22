import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  RECEIVED_MAIL_BYTES,
  RECEIVED_MAIL_TTL_MS,
  receivedMail,
} from "../../ratking-client/src/received-mail.ts";

it.live.prop(
  "only explicitly signed plaintext is recoverable, and updates privately replace the journal instead of overwriting it",
  [Schema.String],
  ([body]) =>
    Effect.gen(function* privateJournal() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* fs.makeTempDirectoryScoped();
      const journal = yield* receivedMail(state, "tester");

      const received = {
        body,
        cc: true,
        ccNames: ["tester"],
        copy: true,
        delegatedFor: "owner",
        delegatedTo: "proxy",
        did: "sender",
        expiresAt: "2099-01-01T00:00:00Z",
        from: "peer",
        id: "signed",
        kind: "ask" as const,
        label: Option.none<string>(),
        originalId: "before-routing",
        quiet: true,
        reply: { parent: "parent", root: "root" },
        replyTo: Option.some("parent"),
        sentBy: "proxy",
        summary: Option.none<string>(),
        thread: "original-thread",
        to: "owner",
        verified: true,
      };

      const sealed = { ...received, body: "sealed body", id: "sealed" };

      yield* journal.save({ encrypted: true, received: sealed });
      const dir = path.join(state, "received-mail");
      expect(yield* fs.exists(dir)).toBe(false);

      const absentSummary = { ...received };
      Reflect.set(absentSummary, "askSummary", undefined);
      yield* journal.save({ encrypted: false, received: absentSummary });
      const [name] = yield* fs.readDirectory(dir);
      expect(name).toBeDefined();
      const file = path.join(dir, name ?? "missing");
      const before = yield* fs.stat(file);
      expect(before.mode % 0o1000).toBe(0o600);

      yield* journal.save({ received: sealed });
      expect(yield* journal.find(sealed.id)).toEqual(Option.none());
      yield* journal.save({
        encrypted: false,
        received: { ...received, body: `${body}!` },
      });

      const after = yield* fs.stat(file);
      expect(after.mode % 0o1000).toBe(0o600);
      expect(Option.isSome(before.ino)).toBe(true);
      expect(after.ino).not.toEqual(before.ino);
      expect(yield* fs.readDirectory(dir)).toEqual([name]);
      expect(yield* fs.readFileString(file)).not.toContain('"sealed"');
      expect(yield* journal.find(received.id)).toEqual(
        Option.some({
          encrypted: false,
          received: { ...received, body: `${body}!` },
        })
      );

      yield* fs.writeFileString(file, "{");
      yield* journal.save({ encrypted: false, received });
      expect(yield* journal.find(received.id)).toEqual(
        Option.some({ encrypted: false, received })
      );
      const files = yield* fs.readDirectory(dir);

      const moved = files.find((candidate) =>
        candidate.startsWith(`${name}.corrupt-`)
      );

      expect(moved).toBeDefined();
      expect(yield* fs.readFileString(path.join(dir, moved ?? "missing"))).toBe(
        "{"
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 } }
);

it.effect.prop(
  "the journal evicts by encoded byte count, refuses an oversized item and stops serving expired plaintext",
  [Schema.Int.check(Schema.isBetween({ maximum: 37_000, minimum: 36_000 }))],
  ([length]) =>
    Effect.gen(function* boundedJournal() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const journal = yield* receivedMail(state, "tester");
      const body = "é".repeat(length);

      const item = (id: string, text = body) => ({
        encrypted: false,
        received: {
          body: text,
          cc: false,
          did: "sender",
          from: "peer",
          id,
          kind: "message" as const,
          label: Option.none<string>(),
          replyTo: Option.none<string>(),
          summary: Option.none<string>(),
          verified: true,
        },
      });

      yield* Effect.forEach(
        ["first", "second", "third", "fourth"],
        (id) => journal.save(item(id)),
        { discard: true }
      );
      const { size } = yield* fs.stat(`${state}/received-mail/tester.json`);
      expect(size).toBeLessThanOrEqual(BigInt(RECEIVED_MAIL_BYTES));
      expect(yield* journal.find("first")).toEqual(Option.none());
      expect(yield* journal.find("fourth")).toEqual(
        Option.some(item("fourth"))
      );

      const failure = yield* journal
        .save(item("oversize", "é".repeat(RECEIVED_MAIL_BYTES)))
        .pipe(Effect.flip);

      expect(failure._tag).toBe("JournalTooLarge");
      expect(yield* journal.find("fourth")).toEqual(
        Option.some(item("fourth"))
      );
      const stale = `${state}/received-mail/tester.json.corrupt-0`;
      yield* fs.writeFileString(stale, "broken plaintext");
      expect(yield* journal.find("fourth")).toBeDefined();
      expect(yield* fs.exists(stale)).toBe(true);
      yield* TestClock.adjust(RECEIVED_MAIL_TTL_MS);
      expect(yield* journal.find("fourth")).toEqual(Option.none());
      expect(
        yield* fs.readFileString(`${state}/received-mail/tester.json`)
      ).toBe("[]");
      expect(yield* fs.exists(stale)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 } }
);
