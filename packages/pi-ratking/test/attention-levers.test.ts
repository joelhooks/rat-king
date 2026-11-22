import { it } from "@effect/vitest";
import * as Prefs from "@rat-king/lexicon/attention.prefs";
import * as Status from "@rat-king/lexicon/attention.status";
import {
  attend,
  forwardNames,
  Reasons,
  Verdicts,
} from "@rat-king/ratking-client/attend";
import {
  decimalPreferences,
  ToolPreferences,
  wirePreferences,
} from "@rat-king/ratking-client/attention";
import { Arbitrary, DateTime, Option, Predicate, Schema } from "effect";
import { expect } from "vitest";

import {
  defaultPreferences,
  defaultStatus,
  fromBasisPoints,
  toBasisPoints,
} from "../../mailbox-client/src/attention.ts";

const PreferencesSample = Schema.Struct({
  ...Prefs.Main.schema.fields,
  digest: Schema.optionalKey(
    Schema.Array(Schema.Struct(Prefs.Digest.schema.fields))
  ),
  model: Schema.Struct({
    ...Prefs.Model.schema.fields,
    jev: Schema.optionalKey(Schema.Struct(Prefs.Jev.schema.fields)),
  }),
  mute: Schema.Array(
    Schema.Union([
      Schema.Struct({
        ...Prefs.Thread.schema.fields,
        $type: Schema.Literal("sh.mschf.ratking.attention.prefs#thread"),
      }),
      Schema.Struct({
        ...Prefs.Group.schema.fields,
        $type: Schema.Literal("sh.mschf.ratking.attention.prefs#group"),
      }),
    ])
  ),
  rules: Schema.optionalKey(Schema.Tuple([])),
});

const prefs = Arbitrary.schema(PreferencesSample);

const status = Arbitrary.schema(
  Schema.Struct({
    $type: Status.Main.schema.fields.$type,
    note: Status.Main.schema.fields.note,
    state: Status.Main.schema.fields.state,
    version: Status.Main.schema.fields.version,
  })
);

const milliseconds = Schema.Int.check(
  Schema.isBetween({ maximum: 1_000_000, minimum: 1 })
);

const arrival = {
  from: "alarm",
  kind: "message" as const,
  thread: "incident",
  verified: true,
};

it.prop(
  "A verified direct prompt from the resolved owner keeps intent under any levers",
  [prefs, status, Schema.Literals(["message", "ask", "reply"])],
  ([preferences, state, kind]) => {
    const owner = "project/desk";
    const direct = { ...arrival, from: "display label", kind, sender: owner };
    const levers = { enabled: true, owner, prefs: preferences, status: state };

    const suggestion = Option.some(
      Verdicts.Never({ reason: Reasons.judge({ facts: [] }) })
    );

    const intent = attend(direct, {}, 0, undefined, Option.none());

    expect(attend(direct, levers, 0, undefined, suggestion)).toEqual(intent);

    const forged = { ...direct, from: owner, sender: "forger" };

    const refusal = {
      ...levers,
      prefs: { ...preferences, refuse: [owner, "forger"] },
    };

    expect(attend(direct, refusal, 0, undefined, suggestion)).toEqual(intent);
    expect(attend(forged, refusal, 0, undefined, suggestion)._tag).toBe(
      "Never"
    );
    expect(
      attend({ ...direct, verified: false }, refusal, 0, undefined, suggestion)
        ._tag
    ).toBe("Never");
    expect(
      attend(direct, { ...refusal, enabled: false }, 0, undefined, suggestion)
    ).toEqual(attend(direct, {}, 0, undefined, suggestion));
    expect(
      attend({ ...direct, copy: true }, refusal, 0, undefined, suggestion)._tag
    ).toBe("Never");
  }
);

const dnd = (until?: string) =>
  Schema.decodeUnknownSync(Status.Main)(
    until === undefined
      ? { ...defaultStatus(), state: "dnd" }
      : { ...defaultStatus(), state: "dnd", until }
  );

it.prop(
  "Direct non-quiet operator mail cannot be demoted by a lever or judge",
  [prefs, status],
  ([preferences, publicStatus]) => {
    const actual = attend(
      { ...arrival, from: "joel" },
      {
        enabled: true,
        prefs: { ...preferences, refuse: ["joel"] },
        status: publicStatus,
      },
      0,
      undefined,
      Option.some(Verdicts.Never({ reason: Reasons.judge({ facts: [] }) }))
    );

    expect(actual._tag).toBe("Now");
    expect(actual.reason._tag).toBe("joel");
  }
);

it.prop(
  "Allowlisted alarm senders cannot be held by DND or thread mute",
  [prefs, Schema.Boolean],
  ([preferences, muted]) => {
    const actual = attend(
      arrival,
      {
        enabled: true,
        prefs: {
          ...preferences,
          allow: ["alarm"],
          mute: muted
            ? [
                {
                  $type: "sh.mschf.ratking.attention.prefs#thread",
                  thread: "incident",
                },
              ]
            : [],
          refuse: [],
        },
        status: dnd(),
      },
      0,
      undefined,
      Option.none()
    );

    expect(actual._tag).toBe("Now");
  }
);

it.prop(
  "Refuse takes precedence over allow and sender intent",
  [prefs],
  ([preferences]) => {
    const actual = attend(
      arrival,
      {
        enabled: true,
        prefs: { ...preferences, allow: ["alarm"], refuse: ["alarm"] },
      },
      0,
      undefined,
      Option.none()
    );

    expect(actual._tag).toBe("Never");
  }
);

it.prop(
  "DND holds only until its expiry, without mutating the status",
  [milliseconds],
  ([delta]) => {
    const until = DateTime.formatIso(DateTime.makeUnsafe(delta));

    const levers = {
      enabled: true,
      prefs: defaultPreferences(),
      status: dnd(until),
    };

    const held = attend(arrival, levers, 0, undefined, Option.none());
    expect(held._tag).toBe("Later");

    if (Predicate.isTagged(held, "Later")) {
      expect(held.window).toBe(delta);
    }

    expect(attend(arrival, levers, delta, undefined, Option.none())._tag).toBe(
      "Now"
    );
    expect(levers.status.until).toBe(until);
  }
);

it.prop(
  "Thread and group mutes hold matching arrivals only",
  [Schema.Boolean],
  ([group]) => {
    const preferences: Prefs.MainValue = {
      ...defaultPreferences(),
      mute: group
        ? [
            {
              $type: "sh.mschf.ratking.attention.prefs#group",
              group: "incident",
            },
          ]
        : [
            {
              $type: "sh.mschf.ratking.attention.prefs#thread",
              thread: "incident",
            },
          ],
    };

    const levers = {
      enabled: true,
      prefs: preferences,
      status: defaultStatus(),
    };

    expect(
      attend(
        { ...arrival, group: "incident" },
        levers,
        0,
        undefined,
        Option.none()
      )._tag
    ).toBe("Later");
    expect(
      attend(
        { ...arrival, group: "other", thread: "other" },
        levers,
        0,
        undefined,
        Option.none()
      )._tag
    ).toBe("Now");
  }
);

it.prop(
  "Flag off ignores every lever and remains byte-identical to the tracer",
  [prefs, status, Schema.Boolean, Schema.Literals(["message", "ask", "reply"])],
  ([preferences, publicStatus, copy, kind]) => {
    const facts = { ...arrival, copy, digestMinutes: 5, kind };
    expect(
      JSON.stringify(
        attend(
          facts,
          { enabled: false, prefs: preferences, status: publicStatus },
          0,
          undefined,
          Option.none()
        )
      )
    ).toBe(JSON.stringify(attend(facts, {}, 0, undefined, Option.none())));
    expect(forwardNames(facts, { enabled: false, prefs: preferences })).toEqual(
      []
    );
  }
);

it.prop(
  "Forward does not replace the original verdict and copies cannot cascade",
  [prefs],
  ([preferences]) => {
    const levers = {
      enabled: true,
      prefs: {
        ...preferences,
        allow: [],
        forward: ["copy/desk"],
        mute: [],
        refuse: [],
      },
    };

    expect(forwardNames(arrival, levers)).toEqual(["copy/desk"]);
    expect(attend(arrival, levers, 0, undefined, Option.none())._tag).toBe(
      "Now"
    );
    expect(forwardNames({ ...arrival, copy: true }, levers)).toEqual([]);
    expect(forwardNames({ ...arrival, sentBy: "desk" }, levers)).toEqual([]);
  }
);

it.prop(
  "Decimal probabilities round trip exactly at four decimal places",
  [Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 0 }))],
  ([points]) => {
    const decimal = points / 10_000;
    expect(fromBasisPoints(toBasisPoints(decimal))).toBe(decimal);

    const preferences: Prefs.MainValue = {
      ...defaultPreferences(),
      model: {
        body: "summary",
        jev: { judgment: "needs attention", laterBp: points, nowBp: points },
        kind: "jev",
        timeoutMs: 2000,
      },
    };

    expect(
      Schema.decodeUnknownSync(Prefs.Main)(
        wirePreferences(
          Schema.decodeUnknownSync(ToolPreferences)(
            decimalPreferences(preferences)
          )
        )
      )
    ).toEqual(preferences);
  }
);
