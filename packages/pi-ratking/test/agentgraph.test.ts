import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as CheckIn from "@rat-king/lexicon/agentgraph.checkin";
import * as Outcome from "@rat-king/lexicon/agentgraph.outcome";
import * as Plan from "@rat-king/lexicon/agentgraph.plan";
import {
  compactRecord,
  invalidRecordText,
  renderRecordBody,
  validateRecord,
} from "@rat-king/ratking-client/agentgraph";
import { RatKing } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  Effect,
  FileSystem,
  JsonSchema,
  Option,
  Result,
  Schema,
  SchemaRepresentation,
} from "effect";
import { expect } from "vitest";

import {
  parseSend,
  render,
  resolveSendRecord,
  Verdicts,
} from "../../../stacks/nest/send.ts";
import { runAction } from "../src/tool.ts";
import pinned from "./fixtures/agentgraph.json" with { type: "json" };

const seams = [
  {
    codec: CheckIn.Main,
    name: "CheckIn",
    source: pinned.schemas.CheckIn.schema,
    type: "sh.mschf.agentgraph.checkin",
  },
  {
    codec: Plan.Main,
    name: "Plan",
    source: pinned.schemas.Plan.schema,
    type: "sh.mschf.agentgraph.plan",
  },
  {
    codec: Outcome.Main,
    name: "Outcome",
    source: pinned.schemas.Outcome.schema,
    type: "sh.mschf.agentgraph.outcome",
  },
];

for (const seam of seams) {
  const source = SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft2020_12(seam.source),
    { patterns: "apply" }
  );

  it.effect.prop(
    `pinned ${seam.name} generated valid and corrupted cases match the lexicon`,
    [Arbitrary.schema(source)],
    ([value]) =>
      Effect.gen(function* alignment() {
        expect(value).toBeTypeOf("object");

        const record = yield* Schema.decodeUnknownEffect(
          Schema.Record(Schema.String, Schema.Json)
        )(value);

        const cases = [
          record,
          { ...record, writescope: [] },
          ...Object.keys(record).map((key) => ({ ...record, [key]: null })),
          ...Object.keys(record).map((key) =>
            Object.fromEntries(
              Object.entries(record).filter(([name]) => name !== key)
            )
          ),
        ];

        for (const candidate of cases) {
          const expected = Result.isSuccess(
            Schema.decodeUnknownResult(Schema.toType(source))(candidate, {
              onExcessProperty: "error",
            })
          );

          expect(
            Result.isSuccess(
              Schema.decodeUnknownResult(seam.codec)({
                $type: seam.type,
                ...candidate,
              })
            )
          ).toBe(expected);
        }
      })
  );
}

const example = {
  brief: null,
  briefMachine: "host-a",
  cleanup: ["Remove scratch files"],
  critical: false,
  goal: "Add widget records",
  guess: {
    model: "acme/model",
    packets: 1,
    thinking: "medium",
    workType: "feature",
  },
  mode: "ask",
  note: "Local pilot",
  project: "acme",
  repo: "acme/widgets",
  row: null,
  version: "0.1",
  writeScope: ["src/widgets.ts"],
};

it.effect.prop(
  "required pilot boundaries refuse malformed content and render known data only",
  [Schema.Boolean],
  ([ask]) =>
    Effect.gen(function* boundaries() {
      const record = yield* validateRecord("sh.mschf.agentgraph.checkin", {
        ...example,
        mode: ask ? "ask" : "fyi",
      });

      expect(record.briefMachine).toBe("host-a");

      expect(Option.getOrThrow(compactRecord(JSON.stringify(record)))).toBe(
        `check-in ${ask ? "ask" : "fyi"}: acme · guess feature acme/model medium · 1 packets`
      );
      expect(renderRecordBody(JSON.stringify(record))).toContain("```json");
      expect(renderRecordBody('{"$type":"sh.acme.unknown","a":1}')).toBe(
        '{"$type":"sh.acme.unknown","a":1}'
      );

      for (const invalid of [
        { ...example, cleanup: [""] },
        { ...example, note: "x".repeat(1001) },
        { ...example, writescope: [] },
      ]) {
        expect(
          yield* validateRecord("sh.mschf.agentgraph.checkin", invalid).pipe(
            Effect.flip
          )
        ).toHaveProperty("_tag", "InvalidRecord");
      }

      const hold = {
        checkIn: "check-1",
        cleanup: [{ owner: "acme", what: "Remove scratch" }],
        constraints: [],
        packets: [
          {
            gates: ["check"],
            model: "acme/model",
            order: 1,
            parallelWith: [],
            thinking: "medium",
            workType: "feature",
            writeScope: [],
            writer: "acme",
          },
        ],
        verdict: "hold",
        version: "0.2",
        why: "Wait for approval",
      };

      const error = yield* validateRecord(
        "sh.mschf.agentgraph.plan",
        hold
      ).pipe(Effect.flip);

      expect(error.reason).toContain("releaseWhen");
      expect(
        yield* validateRecord("sh.mschf.agentgraph.plan", {
          ...hold,
          releaseWhen: "Owner approves",
        })
      ).toHaveProperty("verdict", "hold");
    })
);

it.effect.prop(
  "intercom record refuses before send and sends valid tagged data with a derived summary",
  [Schema.Boolean],
  ([ask]) =>
    Effect.gen(function* action() {
      const sent: unknown[] = [];
      const unavailable = Effect.die("Unexpected service call");

      const service = RatKing.of({
        ask: () => unavailable,
        attention: () => unavailable,
        handled: () => unavailable,
        list: unavailable,
        pending: unavailable,
        reply: () => unavailable,
        retire: () => unavailable,
        roles: unavailable,
        run: () => unavailable,
        send: (to, body, options) =>
          Effect.gen(function* capture() {
            const value = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Json)
            )(body).pipe(Effect.orDie);

            sent.push({ body: value, options, to });

            return {
              did: "did:web:acme.example.invalid",
              id: "check-1",
              seq: 1,
              to,
            };
          }),
        status: unavailable,
      });

      const record = { ...example, mode: ask ? "ask" : "fyi" };

      const invalid = yield* runAction("intercom", 1000, {
        action: "record",
        record: { ...record, writescope: [] },
        to: "acme/desk",
        type: "sh.mschf.agentgraph.checkin",
      }).pipe(Effect.provideService(RatKing, service));

      expect(invalid.isError).toBe(true);
      expect(invalid.text).toBe(
        "NOT SENT: InvalidRecord. writescope: unknown top-level key; allowed: $type, brief, briefMachine, cleanup, critical, goal, guess, mode, note, project, repo, row, supersedes, version, writeScope"
      );
      expect(sent).toEqual([]);

      const badGoal = yield* runAction("intercom", 1000, {
        action: "record",
        record: { ...record, goal: "" },
        to: "acme/desk",
        type: "sh.mschf.agentgraph.checkin",
      }).pipe(Effect.provideService(RatKing, service));

      expect(badGoal.text).toContain("NOT SENT: InvalidRecord.");
      expect(badGoal.text).toContain("goal");
      expect(sent).toEqual([]);

      const valid = yield* runAction("intercom", 1000, {
        action: "record",
        record,
        to: "acme/desk",
        type: "sh.mschf.agentgraph.checkin",
      }).pipe(Effect.provideService(RatKing, service));

      expect(valid.isError).toBe(false);
      expect(sent).toEqual([
        {
          body: { $type: "sh.mschf.agentgraph.checkin", ...record },
          options: {
            cc: [],
            kind: "data",
            summary: `${ask ? "check-in ask" : "check-in"}: acme Add widget records`,
          },
          to: "acme/desk",
        },
      ]);
    })
);

it.effect.prop(
  "nest record uses the same refusal, data kind and default summary before configuration",
  [Schema.Boolean],
  ([valid]) =>
    Effect.gen(function* script() {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = `${dir}/record.json`;
      yield* fs.writeFileString(
        file,
        JSON.stringify(valid ? example : { ...example, writescope: [] })
      );

      const request = Result.getOrThrow(
        parseSend([
          "--as",
          "acme-identity",
          "--to",
          "acme/desk",
          "--record",
          file,
          "--type",
          "sh.mschf.agentgraph.checkin",
        ])
      );

      if (valid) {
        const resolved = yield* resolveSendRecord(request, false);
        expect(resolved.kind).toBe("data");
        expect(resolved.summary).toBe("check-in ask: acme Add widget records");
        expect(JSON.parse(resolved.body)).toHaveProperty(
          "$type",
          "sh.mschf.agentgraph.checkin"
        );
      } else {
        const verdict = yield* resolveSendRecord(request, false).pipe(
          Effect.flip
        );

        const shown = render(verdict);
        expect(shown.code).toBe(2);
        expect(shown.stderr).toBe(
          invalidRecordText(
            yield* validateRecord(request.type, {
              ...example,
              writescope: [],
            }).pipe(Effect.flip)
          )
        );
      }

      expect(
        render(
          Verdicts.Refused({ code: "InvalidRecord", reason: "goal: nonempty" })
        ).stderr
      ).toBe("NOT SENT: InvalidRecord. goal: nonempty");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
