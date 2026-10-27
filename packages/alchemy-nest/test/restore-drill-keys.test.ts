import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  admissionKeyIdentity,
  MessageKey,
  messageKeyIdentity,
  requireMailboxKeys,
} from "../../../stacks/nest/restore-drill-mailbox-projection.ts";
import { proofFailureMetadata } from "../../../stacks/nest/restore-drill-proof-errors.ts";
import { PassingDrillReceipt } from "../../../stacks/nest/restore-drill.ts";
import { localExec } from "../src/local-exec.ts";

it.prop(
  "distinct triples ignore admission replay and ordering, but reject either set difference and equal-cardinality substitutions without leaking keys",
  {
    axis: Arbitrary.schema(
      Schema.Literals(["recipientDid", "senderDid", "messageId"])
    ),
    keys: Arbitrary.schema(
      Schema.Array(MessageKey).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(15)
      )
    ),
    mailboxIndex: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 }))
    ),
    mode: Arbitrary.schema(
      Schema.Literals(["equal", "extra-event", "missing-event", "substitution"])
    ),
  },
  ({ keys, mode, axis, mailboxIndex }) => {
    const stored = keys.map((key, index) => ({
      messageId: `PRIVATE_MESSAGE_${index}:${key.messageId}`,
      recipientDid: `PRIVATE_RECIPIENT_${index}:${key.recipientDid}`,
      senderDid: `PRIVATE_SENDER_${index}:${key.senderDid}`,
    }));

    const [first] = stored;

    expect(first).toBeDefined();

    if (first === undefined) {
      return;
    }

    const replacement = { ...first, [axis]: `${first[axis]}\u0000` };

    const eventKeys = new Set(
      [...stored, ...stored].toReversed().map(messageKeyIdentity)
    );

    expect(JSON.parse(messageKeyIdentity(first))).toEqual([
      first.recipientDid,
      first.senderDid,
      first.messageId,
    ]);
    expect(
      admissionKeyIdentity({
        message: { messageId: first.messageId, senderDid: first.senderDid },
        recipientDid: first.recipientDid,
      })
    ).toBe(messageKeyIdentity(first));

    if (mode === "missing-event" || mode === "substitution") {
      eventKeys.delete(messageKeyIdentity(first));
    }

    if (mode === "extra-event" || mode === "substitution") {
      eventKeys.add(messageKeyIdentity(replacement));
    }

    if (mode === "equal") {
      expect(requireMailboxKeys(stored, eventKeys, mailboxIndex)).toEqual({
        eventKeys: stored.length,
        eventKeysWithoutState: 0,
        stateKeys: stored.length,
        stateKeysWithoutEvent: 0,
      });
    } else {
      let failure: unknown;

      try {
        requireMailboxKeys(stored, eventKeys, mailboxIndex);
      } catch (error) {
        failure = error;
      }

      const metadata = proofFailureMetadata("primary", failure);
      expect(metadata).toMatchObject({
        actual: 1,
        assertionCode:
          mode === "missing-event"
            ? "STATE_KEYS_WITHOUT_EVENT"
            : "EVENT_KEYS_WITHOUT_STATE",
        expected: 0,
        mailboxIndex,
      });

      for (const prefix of [
        "PRIVATE_RECIPIENT_",
        "PRIVATE_SENDER_",
        "PRIVATE_MESSAGE_",
      ]) {
        expect(JSON.stringify(metadata)).not.toContain(prefix);
      }
    }
  }
);

const fixture = String.raw`
import contextlib,json,pathlib,runpy,sqlite3,sys,tempfile
m=runpy.run_path(sys.argv[1],run_name='fixture');states=json.loads(sys.argv[2])
dids=['did:web:reader.example.invalid','did:web:desk.example.invalid']
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp)
 for index,did in enumerate(dids):
  path=root/'celld'/('Mailbox:'+str(index))/'ltx/e1/db.sqlite';path.parent.mkdir(parents=True)
  with contextlib.closing(sqlite3.connect(path)) as db,db:
   db.executescript('CREATE TABLE _cf_METADATA(actor_name TEXT); CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE messages(tid TEXT,sender TEXT,value TEXT,PRIMARY KEY(sender,tid)); CREATE TABLE events(seq INTEGER); CREATE TABLE lease(singleton INTEGER,value TEXT);')
   db.execute('INSERT INTO _cf_METADATA VALUES (?)',(did,));db.execute('INSERT INTO metadata VALUES (?,?)',('recipient',did))
   for offset,state in enumerate(states):
    db.execute('INSERT INTO messages VALUES (?,?,?)',(str(offset),'did:web:sender.example.invalid',json.dumps({'current':{'state':state}})))
   for seq in range(1,len(states)+4):db.execute('INSERT INTO events VALUES (?)',(seq,))
 def no_http(*args):raise AssertionError('Offline key inventory attempted HTTP')
 m['inspect_mailboxes'].__globals__['http_json']=no_http
 result=m['inspect_mailboxes'](root,1,dids,activate=False)
 for box in result['mailboxes']:
  assert box['messages']==len(states) and box['events']==len(states)+3
  assert box['messageKeys']==[{'recipientDid':box['did'],'senderDid':'did:web:sender.example.invalid','messageId':tid} for tid in sorted(str(x) for x in range(len(states)))]
print('OFFLINE_KEY_INVENTORY_PASSED')
`;

it.effect.prop(
  "SQLite key inventory includes every stored message regardless of delivery state and sends no request",
  {
    states: Arbitrary.schema(
      Schema.Array(
        Schema.Literals(["accepted", "delivered", "acked", "expired", "failed"])
      ).check(Schema.isMinLength(1), Schema.isMaxLength(12))
    ),
  },
  ({ states }) =>
    Effect.gen(function* storedKeys() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        JSON.stringify(states),
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("OFFLINE_KEY_INVENTORY_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);

it.prop(
  "a passing receipt requires two key proofs and zero in both set differences",
  {
    count: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
    ),
  },
  ({ count }) => {
    const keyProof = {
      admissionEvents: count + 1,
      duplicateAdmissionEvents: 1,
      eventKeys: count,
      eventKeysWithoutState: 0,
      mailboxIndex: 0,
      stateKeys: count,
      stateKeysWithoutEvent: 0,
    };

    const receipt = {
      archiveId: `20260101T000000.000000Z-${"a".repeat(32)}`,
      error: null,
      proofs: {
        health: { commit: "fixture", version: "fixture" },
        inventories: {
          celld: { bytes: 1, directories: 0, files: 1 },
          seaweedfs: { bytes: 1, directories: 0, files: 1 },
        },
        lease: {
          did: "did:web:example.invalid",
          expiresAt: 1,
          generation: 1,
          leaseId: "fixture",
        },
        mailboxCounts: {
          events: count + 1,
          mailboxes: 2,
          messages: count,
          tolerance: 0,
        },
        mailboxKeyProofs: [keyProof, { ...keyProof, mailboxIndex: 1 }],
        message: {
          messageId: "fixture",
          recipientDid: "did:web:example.invalid",
          senderDid: "did:web:sender.example.invalid",
          seq: 1,
        },
        sha256: "b".repeat(64),
      },
      runId: "a".repeat(32),
      schemaVersion: 1,
      status: "pass",
      teardown: { processesAbsent: true, rootAbsent: true, unitAbsent: true },
    };

    expect(Schema.is(PassingDrillReceipt)(receipt)).toBe(true);

    for (const mailboxKeyProofs of [
      undefined,
      [keyProof],
      [{ ...keyProof, eventKeysWithoutState: count }, keyProof],
      [{ ...keyProof, stateKeysWithoutEvent: count }, keyProof],
    ]) {
      expect(
        Schema.is(PassingDrillReceipt)({
          ...receipt,
          proofs: { ...receipt.proofs, mailboxKeyProofs },
        })
      ).toBe(false);
    }
  }
);
