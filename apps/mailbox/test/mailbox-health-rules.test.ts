import { it } from "@effect/vitest";
import * as Status from "@rat-king/lexicon/attention.status";
import * as Health from "@rat-king/lexicon/mailbox.nameHealth";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { delegates } from "../src/attention-directory.ts";
import { nameHealth } from "../src/name-health.ts";
import type { Sql } from "../src/sqlite.ts";
import { tid } from "../src/tid.ts";
import { testStoreFor } from "./helpers.ts";
import {
  did,
  epoch,
  integer,
  iso,
  receipt,
  serial,
} from "./mailbox-rule-inputs.ts";

const reader = "did:web:reader.example.invalid";

const recipient = "did:web:mailbox.example.invalid";

const sender = "did:web:sender.example.invalid";

const params = Schema.decodeUnknownSync(Health.Params)({
  name: "mailbox",
  recipientDid: recipient,
});

const health = (sql: Sql) => nameHealth(sql, params, reader, [reader]);

const storage = testStoreFor(recipient);

interface Row {
  readonly at: number;
  readonly id: number;
  readonly state: "accepted" | "queued" | "delivered" | "acked";
  readonly woke?: boolean;
  readonly admission?: number;
  readonly admissionSeq?: number | null;
}

const add = (sql: Sql, row: Row) => {
  const messageId = tid(row.at, row.id);

  const encoded = {
    message: { messageId, senderDid: sender },
    recipientDid: recipient,
    recordedAt: iso(row.at),
    seq: row.id,
    state: row.state,
  };

  const current = receipt(
    row.woke === undefined ? encoded : { ...encoded, woke: row.woke }
  );

  const admission = {
    ...current,
    recordedAt: iso(row.admission ?? row.at),
    seq: row.admissionSeq === undefined ? row.id : row.admissionSeq,
    state: "accepted",
  };

  sql.exec(
    "INSERT INTO messages (sender,tid,value) VALUES (?,?,?)",
    sender,
    messageId,
    JSON.stringify({ admission, current })
  );

  return messageId;
};

it.effect.prop(
  "a wake at the exact last ack is not counted as newer",
  [epoch, integer(1, 200)],
  ([at, n]) =>
    Effect.gen(function* sameInstant() {
      const { sql } = yield* storage;
      add(sql, { at, id: n, state: "acked" });
      const first = add(sql, { at, id: n + 1, state: "accepted", woke: true });

      const second = add(sql, {
        at: at + 1,
        id: n + 2,
        state: "delivered",
        woke: true,
      });

      const view = yield* health(sql);
      expect(view.oldestWake?.id).toBe(first);
      expect(view.oldestWakeSinceAck?.id).toBe(second);
      expect(view.wakesSinceAck).toBe(1);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "oldest wake follows recorded time rather than state or admission scan order",
  [epoch, integer(1, 200)],
  ([at, n]) =>
    Effect.gen(function* earlierDelivered() {
      const { sql } = yield* storage;
      add(sql, { at: at + n, id: 1, state: "accepted", woke: true });
      const first = add(sql, { at, id: 2, state: "delivered", woke: true });
      const view = yield* health(sql);
      expect(view.oldestWake?.id).toBe(first);
      expect(view.oldestWakeSinceAck?.id).toBe(first);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "wake cursor uses admission sequence, not the later delivery receipt sequence",
  [epoch, integer(2, 500)],
  ([at, n]) =>
    Effect.gen(function* wakeCursor() {
      const { sql } = yield* storage;

      const message = add(sql, {
        admissionSeq: 1,
        at,
        id: n,
        state: "delivered",
        woke: true,
      });

      const view = yield* health(sql);
      expect(view.oldestWakeSinceAck).toMatchObject({ id: message, seq: 1 });
      expect(view.oldestWake).not.toHaveProperty("seq");
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "the legacy wake shape omits a missing sequence instead of inventing one",
  [epoch, integer(1, 500)],
  ([at, n]) =>
    Effect.gen(function* noSyntheticCursor() {
      const { sql } = yield* storage;
      add(sql, {
        admissionSeq: null,
        at,
        id: n,
        state: "delivered",
        woke: true,
      });
      const view = yield* health(sql);
      expect(view.oldestWakeSinceAck).toBeDefined();
      expect(view.oldestWakeSinceAck).not.toHaveProperty("seq");
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "the backlog age comes from admission, not a later queue receipt",
  [epoch, serial],
  ([at, gap]) =>
    Effect.gen(function* backlogAge() {
      const { sql } = yield* storage;
      add(sql, {
        admission: at,
        at: at + gap,
        id: 1,
        state: "queued",
        woke: true,
      });
      const view = yield* health(sql);
      expect(view.oldestUndeliveredAt).toBe(iso(at));
      expect(view.oldestWake?.recordedAt).toBe(iso(at + gap));
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "a legacy lease falls back to the stored lease ID and omits pane attribution",
  [epoch, serial],
  ([expiresAt, generation]) =>
    Effect.gen(function* oldLease() {
      const { sql } = yield* storage;
      const leaseId = `fixture-${generation}`;
      sql.exec(
        "INSERT INTO lease (singleton,value) VALUES (1,?)",
        JSON.stringify({ expiresAt, generation, leaseId })
      );
      const view = yield* health(sql);
      expect(view.lease).toEqual({
        expiresAt: iso(expiresAt),
        generation,
        holder: leaseId,
      });
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "a retired name projects retirement even with no queued mail",
  [epoch, serial],
  ([at, n]) =>
    Effect.gen(function* retiredHealth() {
      const { sql } = yield* storage;
      sql.exec(
        "INSERT INTO metadata (key,value) VALUES ('retirement',?)",
        JSON.stringify({ by: did(n), name: `mailbox-${n}`, retiredAt: at })
      );
      expect(yield* health(sql)).toEqual({
        complete: true,
        quietUnacked: 0,
        retired: true,
        undelivered: 0,
      });
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "malformed stored health rows fail as unavailable, not as a healthy empty read",
  [serial],
  ([n]) =>
    Effect.gen(function* badLease() {
      const { sql } = yield* storage;
      sql.exec(
        "INSERT INTO lease (singleton,value) VALUES (1,?)",
        JSON.stringify({ generation: -n })
      );
      const result = yield* health(sql).pipe(Effect.result);
      expect(result).toMatchObject({
        failure: { error: "MailboxUnavailable", status: 503 },
      });
    }).pipe(Effect.scoped)
);

const decodeStatus = Schema.decodeUnknownSync(Status.Main);

const status = (state: "busy" | "dnd" | "available", until?: number) => {
  const value = {
    $type: "sh.mschf.ratking.attention.status",
    state,
    version: "0.1",
  };

  return decodeStatus(
    until === undefined ? value : { ...value, until: iso(until) }
  );
};

const busy = Schema.Literals(["busy", "dnd"]);

it.prop(
  "a busy or do-not-disturb delegation stops at its exact expiry",
  [epoch, busy],
  ([until, state]) => {
    const setting = status(state, until);
    expect(delegates(setting, until - 1)).toBe(true);
    expect(delegates(setting, until)).toBe(false);
  }
);

it.prop(
  "being available never enables delegation even with a future deadline",
  [epoch, serial],
  ([now, gap]) => {
    expect(delegates(status("available", now + gap), now)).toBe(false);
  }
);

it.prop(
  "an undated busy or do-not-disturb setting does not acquire an implicit expiry",
  [epoch, serial, busy],
  ([now, gap, state]) => {
    const setting = status(state);
    expect(delegates(setting, now)).toBe(true);
    expect(delegates(setting, now + gap)).toBe(true);
  }
);
