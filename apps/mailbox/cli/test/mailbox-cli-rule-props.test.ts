import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { tid } from "../../src/tid.ts";
import {
  alpha,
  did,
  epoch,
  iso,
  publicDoc,
  serial,
} from "../../test/mailbox-rule-inputs.ts";
import { publicRegistrationDocument } from "../register-document.ts";
import { sendBody } from "../send-body.ts";

const recordFile = (text: string) =>
  FileSystem.layerNoop({ readFileString: () => Effect.succeed(text) });

const load = (text: string) =>
  sendBody({ body: undefined, record: "/example/record.json" }).pipe(
    Effect.provide(recordFile(text))
  );

const runRecord = (value: Schema.Json) => load(JSON.stringify(value));

const json = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

const answer = (n: number) => ({
  $type: "sh.mschf.ratking.desk.answer",
  inReplyTo: tid(1_800_000_000_000, n),
  itemId: `item-${n}`,
  project: `project-${n}`,
  values: { choice: `option-${n}` },
});

it.effect.prop(
  "inline bodies are returned byte-for-byte without interpreting JSON",
  [Schema.String],
  ([body]) =>
    Effect.gen(function* plainBody() {
      const noRead = FileSystem.layerNoop({
        readFileString: () => Effect.die("unexpected file read"),
      });

      expect(
        yield* sendBody({ body, record: undefined }).pipe(
          Effect.provide(noRead)
        )
      ).toBe(body);
    })
);

it.effect.prop(
  "inline and file inputs cannot both be supplied",
  [Schema.String, alpha],
  ([body, file]) =>
    Effect.gen(function* exclusiveSource() {
      const result = yield* sendBody({
        body,
        record: `/example/${file}.json`,
      }).pipe(Effect.provide(recordFile("")), Effect.result);

      expect(result).toMatchObject({
        failure: { reason: "Supply exactly one of --body or --record" },
      });
    })
);

it.effect.prop(
  "record files reject leading non-JSON text even before a valid desk record",
  [serial, alpha],
  ([n, word]) =>
    Effect.gen(function* strictJson() {
      const result = yield* load(`${word}\n${JSON.stringify(answer(n))}`).pipe(
        Effect.result
      );

      expect(result).toMatchObject({
        failure: { reason: "Invalid desk JSON record" },
      });
    })
);

it.effect.prop(
  "a valid JSON object of another collection is not an allowed desk record",
  [alpha, serial],
  ([name, n]) =>
    Effect.gen(function* otherCollection() {
      const result = yield* runRecord({
        ...answer(n),
        $type: `sh.example.${name}.record`,
      }).pipe(Effect.result);

      expect(result).toMatchObject({
        failure: { reason: "Invalid desk JSON record" },
      });
    })
);

it.effect.prop(
  "desk answer fields preserve string selections and repeated row choices",
  [serial, alpha, alpha],
  ([n, a, b]) =>
    Effect.gen(function* rowSelections() {
      const record = { ...answer(n), rows: { next: [a, b, a] } };
      expect(json(yield* runRecord(record))).toEqual(record);
    })
);

it.effect.prop(
  "answer choices cannot be numbers just because the outer record accepts lexicon data",
  [serial, alpha],
  ([n, key]) =>
    Effect.gen(function* numericChoice() {
      const result = yield* runRecord({
        ...answer(n),
        values: { [key]: n },
      }).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
    })
);

it.effect.prop(
  "a desk answer rejects any non-string row member without truncating the other rows",
  [serial, alpha],
  ([n, selected]) =>
    Effect.gen(function* invalidRow() {
      const result = yield* runRecord({
        ...answer(n),
        rows: { good: [selected], mixed: [selected, n] },
      }).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
    })
);

it.effect.prop(
  "a desk update preserves its project and known terminal state",
  [serial, Schema.Literals(["resolved", "superseded", "followup"])],
  ([n, state]) =>
    Effect.gen(function* update() {
      const record = {
        $type: "sh.mschf.ratking.desk.update",
        itemId: `item-${n}`,
        project: `project-${n}`,
        state,
        text: `note-${n}`,
      };

      expect(json(yield* runRecord(record))).toEqual(record);
    })
);

it.effect.prop(
  "a desk item cannot offer a choice with no available options",
  [serial, epoch],
  ([n, at]) =>
    Effect.gen(function* emptyChoice() {
      const result = yield* runRecord({
        $type: "sh.mschf.ratking.desk.item",
        body: "Body",
        choices: [
          { key: `choice-${n}`, label: "Choice", options: [], suggest: "none" },
        ],
        createdAt: iso(at),
        itemId: `item-${n}`,
        kind: "decision",
        project: "demo",
        refs: [],
        title: "Title",
        why: "Why",
      }).pipe(Effect.result);

      expect(result).toMatchObject({
        failure: { reason: "Invalid desk JSON record" },
      });
    })
);

it.effect.prop(
  "public document registration preserves matching authentication and agreement methods",
  [serial],
  ([n]) =>
    Effect.gen(function* publicOnly() {
      const identity = did(n);
      const document = publicDoc(identity, n);
      expect(
        yield* publicRegistrationDocument(identity, JSON.stringify(document))
      ).toEqual(document);
    })
);

it.effect.prop(
  "registration refuses a valid public document for a differently named DID",
  [serial],
  ([n]) =>
    Effect.gen(function* mismatchedDid() {
      const result = yield* publicRegistrationDocument(
        did(n),
        JSON.stringify(publicDoc(did(n + 1), n))
      ).pipe(Effect.result);

      expect(result).toMatchObject({
        failure: { reason: "Document DID does not match --did" },
      });
    })
);

it.effect.prop(
  "registration refuses even an exactly matching DID from another method",
  [alpha, serial],
  ([label, n]) =>
    Effect.gen(function* wrongMethod() {
      const identity = `did:example:${label}`;

      const result = yield* publicRegistrationDocument(
        identity,
        JSON.stringify(publicDoc(identity, n))
      ).pipe(Effect.result);

      expect(result).toMatchObject({
        failure: { reason: "Document DID does not match --did" },
      });
    })
);

it.effect.prop(
  "registration refuses recognized private material recursively inside extension arrays",
  [serial, Schema.Literals(["d", "privateScalar", "seed"])],
  ([n, slot]) =>
    Effect.gen(function* privateExtension() {
      const identity = did(n);

      const document = {
        ...publicDoc(identity, n),
        extensions: [{ projection: { [slot]: `synthetic-${n}` } }],
      };

      const result = yield* publicRegistrationDocument(
        identity,
        JSON.stringify(document)
      ).pipe(Effect.result);

      expect(result).toMatchObject({
        failure: { reason: "Refusing private key material" },
      });
    })
);

it.effect.prop(
  "invalid registration JSON and invalid public document shape remain distinct refusals",
  [serial, alpha],
  ([n, prefix]) =>
    Effect.gen(function* decodeStages() {
      const identity = did(n);

      const malformed = yield* publicRegistrationDocument(
        identity,
        `${prefix}{}`
      ).pipe(Effect.result);

      const invalidDocument = yield* publicRegistrationDocument(
        identity,
        JSON.stringify({ id: identity, verificationMethod: n })
      ).pipe(Effect.result);

      expect(malformed).toMatchObject({
        failure: { reason: "Invalid document JSON" },
      });
      expect(invalidDocument).toMatchObject({
        failure: { reason: "Invalid public DID document" },
      });
    })
);
