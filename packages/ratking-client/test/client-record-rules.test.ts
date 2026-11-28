import { it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { expect } from "vitest";

import {
  recordNotice,
  recordRuleVerdict,
  SILENT_RECORD_TYPES,
} from "../src/record-visibility.ts";
import { alpha, epoch, id, integer, iso } from "./client-rule-inputs.ts";

const inbound = (n: number, $type: string) => ({
  body: JSON.stringify({ $type, value: n }),
  did: `did:web:example.invalid:source:${n}`,
  from: `desk-${n}`,
  id: `record-${n}`,
  record: { $type },
  replyTo: Option.none(),
  verified: true,
});

const rule = (n: number, match: Readonly<Record<string, string>> = {}) => ({
  id: `rule-${n}`,
  match,
  route: "hide",
});

const levers = (rules: readonly unknown[]) => ({
  enabled: true,
  owner: "other",
  prefs: {
    allow: [],
    forward: [],
    log: false,
    model: { body: "never", kind: "none", timeoutMs: 1000 },
    mute: [],
    refuse: [],
    rules,
    version: "0.1",
  },
});

const type = "sh.example.demo.record";

it.prop(
  "an already settled unrendered record never produces a second notice",
  [alpha(12), id],
  ([part, n]) => {
    const message = inbound(n, `sh.example.${part}.record`);
    expect(recordNotice(message, false)).toBeDefined();
    expect(recordNotice(message, true)).toBeUndefined();
  }
);

it.prop(
  "unrendered notice attribution chooses a verified name, otherwise the sender DID",
  [alpha(12), id],
  ([part, n]) => {
    const $type = `sh.example.${part}.record`;
    const message = inbound(n, $type);
    expect(recordNotice(message, false)).toContain(
      `record ${$type} from ${message.from} (id ${message.id})`
    );
    expect(recordNotice({ ...message, verified: false }, false)).toContain(
      `record ${$type} from ${message.did} (id ${message.id})`
    );
  }
);

it.prop(
  "silent control types do not receive a fallback notice, regardless of the unrendered payload",
  [Schema.Literals(SILENT_RECORD_TYPES), id],
  ([$type, n]) => {
    expect(recordNotice(inbound(n, $type), false)).toBeUndefined();
  }
);

it.prop(
  "a record with no usable type never gets a synthetic unknown-type notice",
  [Schema.Json, id],
  ([value, n]) => {
    const message = inbound(n, type);
    expect(
      recordNotice({ ...message, body: JSON.stringify({ value }) }, false)
    ).toBeUndefined();
  }
);

it.prop(
  "disabled attention levers do not apply an otherwise matching hide rule",
  [id, epoch],
  ([n, now]) => {
    const message = inbound(n, type);
    const enabled = levers([rule(n)]);
    expect(recordRuleVerdict({ ...message, levers: enabled }, now)?._tag).toBe(
      "Never"
    );
    expect(
      recordRuleVerdict(
        { ...message, levers: { ...enabled, enabled: false } },
        now
      )
    ).toBeUndefined();
  }
);

it.prop(
  "a verified owner bypasses levers while an unverified name does not",
  [id, epoch],
  ([n, now]) => {
    const message = inbound(n, type);
    const prefs = { ...levers([rule(n)]), owner: message.from };
    expect(
      recordRuleVerdict({ ...message, levers: prefs }, now)
    ).toBeUndefined();
    expect(
      recordRuleVerdict({ ...message, levers: prefs, verified: false }, now)
        ?._tag
    ).toBe("Never");
  }
);

it.prop(
  "an expired record rule stops hiding at the exact expiry instant",
  [id, epoch],
  ([n, until]) => {
    const message = {
      ...inbound(n, type),
      levers: levers([{ ...rule(n), until: iso(until) }]),
    };

    expect(recordRuleVerdict(message, until - 1)?._tag).toBe("Never");
    expect(recordRuleVerdict(message, until)).toBeUndefined();
  }
);

it.prop(
  "a record digest rule preserves its window and type filter",
  [id, epoch, integer(1, 1440)],
  ([n, now, minutes]) => {
    const prefs = levers([{ ...rule(n, { type }), minutes, route: "digest" }]);

    const verdict = recordRuleVerdict(
      { ...inbound(n, type), levers: prefs },
      now
    );

    expect(verdict?._tag).toBe("Later");
    expect(verdict).toMatchObject({ window: minutes * 60_000 });
    expect(
      recordRuleVerdict({ ...inbound(n, `${type}.other`), levers: prefs }, now)
    ).toBeUndefined();
  }
);

it.prop(
  "malformed attention preferences cannot partially hide a record",
  [id, epoch],
  ([n, now]) => {
    const prefs = levers([rule(n), { ...rule(n + 1), minutes: 5 }]);
    expect(
      recordRuleVerdict({ ...inbound(n, type), levers: prefs }, now)
    ).toBeUndefined();
  }
);
