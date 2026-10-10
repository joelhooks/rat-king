import { it } from "@effect/vitest";
import { Effect, Match, Schema, Stream } from "effect";
import { expect } from "vitest";

import { countFrames, doneBar } from "../../../stacks/nest/comms.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";

it.prop(
  "stage config rejects missing fields, unknown settings and invalid stage or boolean values",
  [StageConfig, Schema.Literals(["missing", "unknown", "stage", "boolean"])],
  ([config, mutation]) => {
    const runtime = { ...config.runtime };

    const candidate = Match.value(mutation).pipe(
      Match.when("missing", () => ({ ...config, runtime: {} })),
      Match.when("unknown", () => ({
        ...config,
        runtime: { ...runtime, UNDECLARED: "fixture.invalid" },
      })),
      Match.when("stage", () => ({
        ...config,
        runtime: { ...runtime, RAT_KING_STAGE: "fixture.invalid" },
      })),
      Match.when("boolean", () => ({
        ...config,
        runtime: { ...runtime, RAT_KING_CLAUDE_SIDECAR: "false" },
      })),
      Match.exhaustive
    );

    expect(
      Schema.decodeUnknownOption(StageConfig)(candidate, {
        onExcessProperty: "error",
      })._tag
    ).toBe("None");
  }
);

const Call = Schema.Struct({
  action: Schema.Literals([
    "send",
    "ask",
    "reply",
    "handover",
    "status",
    "list",
  ]),
  recent: Schema.Boolean,
  result: Schema.Literals(["raw", "ratking", "missing"]),
});

const Route = Schema.Struct({
  failed: Schema.Boolean,
  fallback: Schema.Boolean,
  recent: Schema.Boolean,
});

it.effect.prop(
  "digest classification scopes transcript results per file and counts recent routes, losses and quarantine",
  [
    Schema.Array(Call),
    Schema.Array(Route),
    Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 })),
    Schema.Boolean,
  ],
  ([calls, routes, quarantined, reverse]) =>
    Effect.gen(function* transcriptClassification() {
      const frames = calls.flatMap((call, index) => {
        const file = `session-${index}.invalid`;

        const timestamp = call.recent
          ? "2026-10-10T01:00:00Z"
          : "2026-10-08T01:00:00Z";

        const toolCall = {
          content: [
            {
              arguments: { action: call.action },
              id: "same-id",
              name: "intercom",
              type: "toolCall",
            },
          ],
          role: "assistant",
        };

        const toolResult = {
          content: [
            {
              text:
                call.result === "ratking"
                  ? "Delivered over Rat King"
                  : "Legacy send",
              type: "text",
            },
          ],
          role: "toolResult",
          toolCallId: "same-id",
          toolName: "intercom",
        };

        return [
          toolCall,
          ...(call.result === "missing" ? [] : [toolResult]),
        ].map((message) => ({
          file,
          kind: "session" as const,
          line: JSON.stringify({ message, timestamp }),
        }));
      });

      const receiptFrames = routes.map((route) => ({
        kind: "receipt" as const,
        line: JSON.stringify({
          at: route.recent ? "2026-10-10T01:00:00Z" : "2026-10-08T01:00:00Z",
          fallback: { status: route.failed ? "failed" : "delivered" },
          path: route.fallback ? "intercom-fallback" : "network",
        }),
      }));

      const allFrames = [
        ...frames,
        ...receiptFrames,
        ...Array.from({ length: quarantined }, () => ({
          kind: "quarantine" as const,
        })),
      ];

      const counts = yield* countFrames(
        Stream.fromIterable(reverse ? allFrames.toReversed() : allFrames),
        Date.parse("2026-10-09T01:00:00Z")
      );

      const sends = calls.filter(
        (call) => call.recent && !["status", "list"].includes(call.action)
      );

      const recentRoutes = routes.filter((route) => route.recent);

      expect(counts.sent).toBe(recentRoutes.length);
      expect(counts.fallbacks).toBe(
        recentRoutes.filter((route) => route.fallback).length
      );
      expect(counts.lost).toBe(
        recentRoutes.filter((route) => route.fallback && route.failed).length
      );
      expect(counts.quarantined).toBe(quarantined);
      expect(counts.raw).toBe(
        sends.filter((call) => call.result !== "ratking").length
      );
      expect(counts.ratking).toBe(
        sends.filter((call) => call.result === "ratking").length
      );
    })
);

const Thresholds = Schema.Struct({
  localLost: Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 })),
  localRaw: Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 })),
  remoteLost: Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 })),
  remoteRaw: Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 })),
});

it.prop(
  "done-bar passes only with zero raw sends and zero losses on each host",
  [Thresholds],
  ([counts]) => {
    const other = { fallbacks: 3, quarantined: 2, ratking: 10, sent: 50 };

    const passed = doneBar(
      { ...other, lost: counts.localLost, raw: counts.localRaw },
      { ...other, lost: counts.remoteLost, raw: counts.remoteRaw }
    );

    expect(passed).toBe(Object.values(counts).every((count) => count === 0));
    expect(
      doneBar({ ...other, lost: 0, raw: 0 }, { ...other, lost: 0, raw: 0 })
    ).toBe(true);
  }
);
