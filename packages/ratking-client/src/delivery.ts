import { Match, Option, Schema } from "effect";

import type { KindValue } from "../../mailbox-client/src/payload.ts";
import { decodeAgentGraphBody } from "./agentgraph.ts";
import { attend, Reasons } from "./attend.ts";
import type { Arrival, Reason } from "./attend.ts";

export interface AttentionTarget {
  readonly body?: string;
  readonly kind: string;
}

export const injects = (inbound: AttentionTarget, settled: boolean) =>
  !settled &&
  (inbound.kind !== "data" ||
    (inbound.body !== undefined &&
      Option.isSome(decodeAgentGraphBody(inbound.body))));

export const WakeLevel = Schema.Literals(["wake", "quiet"]);

export type WakeLevelValue = typeof WakeLevel.Type;

export const RecipientLevel = Schema.Struct({
  level: WakeLevel,
  name: Schema.String,
});

export type RecipientLevelValue = typeof RecipientLevel.Type;

export const Recipients = Schema.Array(RecipientLevel);

export const DeliveryReason = Schema.Struct({
  _tag: Schema.Literals(["intent", "lever", "judge", "joel", "delegated"]),
  facts: Schema.Array(
    Schema.Literals([
      "to",
      "cc",
      "quiet",
      "ask",
      "reply",
      "relay",
      "digest",
      "wake",
    ])
  ),
});

export type DeliveryReasonValue = typeof DeliveryReason.Type;

export const DIGEST_REASON: Reason = Reasons.intent({
  facts: ["cc", "digest"],
});

export const deliveryReason = (arrival: Arrival): Reason =>
  attend(arrival, {}, 0, undefined, Option.none()).reason;

export const storedReason = (
  reason: Reason | string | undefined
): Reason | undefined =>
  Match.value(reason).pipe(
    Match.when("held: cc digest", () => DIGEST_REASON),
    Match.when("held: quiet digest", () =>
      Reasons.intent({ facts: ["quiet", "digest"] })
    ),
    Match.when("quiet: sender", () => Reasons.intent({ facts: ["quiet"] })),
    Match.when("held: digest", () => Reasons.lever({ facts: ["digest"] })),
    Match.when("quiet: cc", () => Reasons.intent({ facts: ["cc"] })),
    Match.when("woken: ask", () => Reasons.intent({ facts: ["ask"] })),
    Match.when("woken: reply", () => Reasons.intent({ facts: ["reply"] })),
    Match.when("woken: to", () => Reasons.intent({ facts: ["to"] })),
    Match.when(Match.string, (): Reason | undefined => undefined),
    Match.orElse((value) => value)
  );

export const recipientLevels = (
  to: string,
  cc: readonly string[],
  kind: KindValue,
  quiet?: boolean
): readonly RecipientLevelValue[] => [
  { level: quiet === true && kind !== "ask" ? "quiet" : "wake", name: to },
  ...cc.map((name): RecipientLevelValue => ({
    level: kind === "ask" ? "wake" : "quiet",
    name,
  })),
];

const levelText = (recipient: RecipientLevelValue, index: number) => {
  if (index === 0) {
    return recipient.level === "quiet"
      ? "quiet copy, no wake (to: shows next turn or at its digest)"
      : "woken (to)";
  }

  return recipient.level === "wake"
    ? "woken (cc of an ask)"
    : "quiet copy, no wake (cc: shows next turn or at its digest)";
};

export const recipientLines = (recipients: readonly RecipientLevelValue[]) =>
  recipients.map(
    (recipient, index) => `${recipient.name}: ${levelText(recipient, index)}.`
  );
