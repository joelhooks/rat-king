import * as Prefs from "@rat-king/lexicon/attention.prefs";
import type { Inbound, InboundRecord } from "@rat-king/ratking-client/payload";
import { Cause, Clock, Effect, Option, Result, Schema } from "effect";

import { shownIds } from "./pending.ts";
import type { SessionMessage } from "./pending.ts";

export const JEV_MODEL = "jev-latest";

export const SHADOW_DEFAULTS = {
  judgment: "Does this message need attention or an answer now?",
  laterBp: 2500,
  nowBp: 7500,
  timeoutMs: 2000,
} as const;

export const PRIVATE_NAMES = [
  { name: "front-desk", reason: "front-desk" },
  { name: "switchboard/ea", reason: "ea" },
  { name: "secret-cell", reason: "secret-cell" },
] as const;

type PrivateReason = (typeof PRIVATE_NAMES)[number]["reason"];

type InboundMail = Inbound | InboundRecord;

const Policy = Schema.Struct({
  prefs: Schema.optionalKey(
    Schema.Struct({ model: Schema.optionalKey(Prefs.Model) })
  ),
});

const inNamespace = (name: string | undefined, root: string) =>
  name === root || name?.startsWith(`${root}/`) === true;

export const exclusion = (
  inbound: InboundMail,
  reader: string
): PrivateReason | "encrypted" | "unverified" | undefined => {
  if (inbound.encrypted !== false) {
    return "encrypted";
  }

  const names = [inbound.from];

  if (!("record" in inbound)) {
    if (
      inbound.relay?.encrypted === true ||
      inbound.threadRouter?.encrypted === true
    ) {
      return "encrypted";
    }

    for (const name of [
      inbound.sender,
      inbound.sentBy,
      inbound.relay?.name,
      inbound.threadRouter?.name,
      inbound.via?.desk,
    ]) {
      if (name !== undefined) {
        names.push(name);
      }
    }
  }

  const matched = PRIVATE_NAMES.find(({ name, reason }) => {
    const candidates =
      reason === "ea"
        ? [...names, reader, "record" in inbound ? undefined : inbound.to]
        : names;

    return candidates.some((candidate) => inNamespace(candidate, name));
  });

  return matched?.reason ?? (inbound.verified ? undefined : "unverified");
};

const Routes = Schema.Literals(["now", "later", "quiet"]);

const Outcomes = Schema.Literals(["acted", "ack", "none"]);

const Probability = Schema.Finite.check(
  Schema.isBetween({ maximum: 1, minimum: 0 })
);

const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Skips = Schema.Literals([
  "encrypted",
  "front-desk",
  "ea",
  "secret-cell",
  "unverified",
  "no-key",
  "unavailable",
  "provider-error",
  "timeout",
]);

export type Route = typeof Routes.Type;

export type Skip = typeof Skips.Type;

const scoreFields = {
  id: Schema.String,
  latencyMs: Schema.NullOr(Schema.Finite),
  model: Schema.Literal(JEV_MODEL),
  rule: Schema.NullOr(Schema.Literals(["Now", "Next", "Later", "Never"])),
  time: Schema.Finite,
  type: Schema.Literal("score"),
};

const Score = Schema.Union([
  Schema.Struct({
    ...scoreFields,
    inputTokens: Schema.NullOr(Tokens),
    outputTokens: Schema.NullOr(Tokens),
    probability: Probability,
    skipped: Schema.Null,
    verdict: Routes,
  }),
  Schema.Struct({
    ...scoreFields,
    inputTokens: Schema.Null,
    outputTokens: Schema.Null,
    probability: Schema.Null,
    skipped: Skips,
    verdict: Schema.Null,
  }),
]);

export const ShadowRow = Schema.Union([
  Score,
  Schema.Struct({
    id: Schema.String,
    outcome: Outcomes,
    time: Schema.Finite,
    type: Schema.Literal("outcome"),
  }),
]);

export type ShadowRowValue = typeof ShadowRow.Type;

export type ScoreRow = typeof Score.Type;

type ScoreBase = Pick<ScoreRow, "id" | "model" | "rule" | "time" | "type">;

const AnswerSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Tokens),
  outputTokens: Schema.NullOr(Tokens),
  probability: Probability,
});

export type Answer = typeof AnswerSchema.Type;

export interface JevQuestion {
  readonly judgment: string;
  readonly state: {
    readonly summary: string;
    readonly kind: string;
    readonly sender: string;
    readonly role: "to" | "cc";
    readonly quiet: boolean;
    readonly body?: string;
  };
}

export type ClassifyJev = (
  question: JevQuestion
) => Effect.Effect<Answer, "no-key" | "unavailable" | "provider-error">;

export const mappedRoute = (
  probability: number,
  nowBp: number,
  laterBp: number
): Route => {
  if (probability >= nowBp / 10_000) {
    return "now";
  }

  return probability >= laterBp / 10_000 ? "later" : "quiet";
};

const SentMessage = Schema.Struct({
  customType: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Unknown),
  role: Schema.String,
});

const Assistant = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      text: Schema.optionalKey(Schema.String),
      type: Schema.String,
    })
  ),
  role: Schema.Literal("assistant"),
});

const ToolResult = Schema.Struct({ role: Schema.Literal("toolResult") });

const turnOutcome = (
  messages: readonly unknown[],
  sent: boolean
): typeof Outcomes.Type => {
  const content = messages.flatMap((message) => {
    const decoded = Schema.decodeUnknownOption(Assistant)(message);

    return Option.isSome(decoded) ? decoded.value.content : [];
  });

  if (
    sent ||
    messages.some(Schema.is(ToolResult)) ||
    content.some(({ type }) => type === "toolCall")
  ) {
    return "acted";
  }

  return content.some(
    ({ type, text }) => type === "text" && (text?.trim().length ?? 0) > 0
  )
    ? "ack"
    : "none";
};

const runDetached = (effect: Effect.Effect<void>) => {
  Effect.runFork(
    Effect.yieldNow.pipe(Effect.andThen(effect), Effect.ignoreCause)
  );
};

const questionOf = (
  inbound: InboundMail,
  judgment: string,
  full: boolean
): JevQuestion => {
  const record = "record" in inbound;

  const state: JevQuestion["state"] = {
    kind: record ? "data" : inbound.kind,
    quiet: !record && inbound.quiet === true,
    role: inbound.cc === true ? "cc" : "to",
    sender: inbound.from,
    summary: record
      ? inbound.record.$type
      : Option.getOrElse(inbound.summary, () => ""),
  };

  if (full) {
    return {
      judgment,
      state: {
        ...state,
        body: record ? JSON.stringify(inbound.record) : inbound.body,
      },
    };
  }

  return { judgment, state };
};

const skippedRow = (
  base: ScoreBase,
  skipped: Skip,
  latencyMs: number | null
): ScoreRow => ({
  ...base,
  inputTokens: null,
  latencyMs,
  outputTokens: null,
  probability: null,
  skipped,
  verdict: null,
});

const evaluate = (
  classify: ClassifyJev,
  inbound: InboundMail,
  prefs: Prefs.ModelValue | undefined,
  base: ScoreBase
) =>
  Effect.gen(function* classifyShadow() {
    const thresholds = prefs?.jev ?? SHADOW_DEFAULTS;

    const question = questionOf(
      inbound,
      thresholds.judgment,
      prefs?.body === "full"
    );

    const begin = yield* Clock.currentTimeMillis;

    const result = yield* Effect.suspend(() => classify(question)).pipe(
      Effect.filterOrFail(
        Schema.is(AnswerSchema),
        () => "provider-error" as const
      ),
      Effect.timeoutOption(prefs?.timeoutMs ?? SHADOW_DEFAULTS.timeoutMs),
      Effect.catchCause((cause) =>
        Effect.fail(
          Option.getOrElse(
            Cause.findErrorOption(cause),
            () => "provider-error" as const
          )
        )
      ),
      Effect.result
    );

    const latencyMs = Math.max(0, (yield* Clock.currentTimeMillis) - begin);

    if (Result.isFailure(result)) {
      return skippedRow(base, result.failure, latencyMs);
    }

    if (Option.isNone(result.success)) {
      return skippedRow(base, "timeout", latencyMs);
    }

    const { inputTokens, outputTokens, probability } = result.success.value;

    return {
      ...base,
      inputTokens,
      latencyMs,
      outputTokens,
      probability,
      skipped: null,
      verdict: mappedRoute(probability, thresholds.nowBp, thresholds.laterBp),
    } satisfies ScoreRow;
  });

export const shadowReader = ({
  append,
  classify,
  envEnabled,
  reader,
}: {
  readonly append: (reader: string, row: ShadowRowValue) => Effect.Effect<void>;
  readonly classify: ClassifyJev;
  readonly envEnabled: boolean;
  readonly reader: () => string | undefined;
}) => {
  const seen = new Set<string>();
  const offered = new Map<string, string>();
  let active = false;
  let sent = false;

  return {
    endTurn: (messages: readonly unknown[]) => {
      active = false;

      if (offered.size === 0) {
        return;
      }

      const ids = messages.flatMap((message) =>
        Option.match(Schema.decodeUnknownOption(SentMessage)(message), {
          onNone: () => [],
          onSome: shownIds,
        })
      );

      const outcome = turnOutcome(messages, sent);

      for (const id of ids) {
        const name = offered.get(id);

        if (name !== undefined) {
          offered.delete(id);
          runDetached(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((time) =>
                append(name, { id, outcome, time, type: "outcome" })
              )
            )
          );
        }
      }
    },
    observe: (inbound: InboundMail, rule: ScoreBase["rule"], time: number) => {
      const model = Option.getOrUndefined(
        Schema.decodeUnknownOption(Policy)(inbound.levers)
      )?.prefs?.model;

      const prefs = model?.kind === "jev" ? model : undefined;
      const name = reader();

      if (
        name === undefined ||
        (!envEnabled && prefs === undefined) ||
        seen.has(inbound.id)
      ) {
        return;
      }

      const { id } = inbound;
      seen.add(id);

      const base = { id, model: JEV_MODEL, rule, time, type: "score" } as const;
      const excluded = exclusion(inbound, name);

      const score =
        excluded === undefined
          ? evaluate(classify, inbound, prefs, base)
          : Effect.succeed(skippedRow(base, excluded, null));

      runDetached(score.pipe(Effect.flatMap((row) => append(name, row))));
    },
    offer: (message: SessionMessage) => {
      const name = reader();

      if (name === undefined || seen.size === 0) {
        return;
      }

      for (const id of shownIds(message)) {
        if (seen.has(id)) {
          offered.set(id, name);
        }
      }
    },
    send: () => {
      if (active) {
        sent = true;
      }
    },
    startTurn: () => {
      sent = false;
      active = true;
    },
  };
};
