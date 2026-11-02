import * as Prefs from "@rat-king/lexicon/attention.prefs";
import { recordType } from "@rat-king/mailbox-client";
import { Option, Schema } from "effect";

import { decodeAgentGraphBody } from "./agentgraph.ts";
import { ruleVerdict } from "./attend.ts";
import type { Verdict } from "./attend.ts";
import type { InboundRecord } from "./payload.ts";

const RecordLevers = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  owner: Schema.optionalKey(Schema.String),
  prefs: Schema.optionalKey(Prefs.Main),
});

export const recordRuleVerdict = (
  inbound: InboundRecord,
  now: number
): Verdict | undefined => {
  const levers = Schema.decodeUnknownOption(RecordLevers)(inbound.levers);

  if (
    Option.isNone(levers) ||
    levers.value.enabled !== true ||
    (inbound.verified && inbound.from === levers.value.owner)
  ) {
    return undefined;
  }

  return ruleVerdict(
    {
      from: inbound.from,
      kind: "data",
      type: inbound.record.$type,
      verified: inbound.verified,
    },
    levers.value.prefs?.rules,
    now
  );
};

export const CONTROL_RECORD_TYPES: readonly string[] = [
  "sh.mschf.agentgraph.turn",
  "sh.mschf.agentgraph.wake",
];

export const SILENT_RECORD_TYPES: readonly string[] = [
  ...CONTROL_RECORD_TYPES,
  "sh.mschf.agentgraph.friction",
  "sh.mschf.ratking.relay#outbound",
];

export const RENDERS: readonly string[] = [
  "sh.mschf.agentgraph.*",
  "sh.mschf.ratking.relay#message",
  "sh.mschf.ratking.relay#handled",
  "sh.mschf.ratking.thread#control",
  "sh.mschf.ratking.thread#message",
  "sh.mschf.rulegarden.*",
  ...SILENT_RECORD_TYPES,
];

export const recordNotice = (
  inbound: {
    readonly body: string;
    readonly id: string;
    readonly from: string;
    readonly did: string;
    readonly verified: boolean;
  },
  settled: boolean
): string | undefined => {
  const type = recordType(inbound.body);

  if (
    settled ||
    type === "unknown" ||
    SILENT_RECORD_TYPES.includes(type) ||
    Option.isSome(decodeAgentGraphBody(inbound.body))
  ) {
    return undefined;
  }

  return `📦 record ${type} from ${inbound.verified ? inbound.from : inbound.did} (id ${inbound.id}), not rendered by this reader`;
};
