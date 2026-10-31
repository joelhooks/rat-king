import { it } from "@effect/vitest";
import { Reasons } from "@rat-king/ratking-client/attend";
import { COPY_NOTE } from "@rat-king/ratking-client/payload";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import { renderDigest } from "../src/extension.ts";

const RuleId = Schema.String.check(Schema.isMinLength(1));

it.prop(
  "A wake digest of mail held by the receiver's own filter names that filter and never claims a cc",
  [Arbitrary.schema(Schema.NonEmptyArray(RuleId))],
  ([rules]) => {
    const mails = rules.map((rule, index) => ({
      content: "",
      details: {},
      id: String(index),
      reason: Reasons.lever({ facts: ["quiet"], rule }),
    }));

    const text = renderDigest("ratking", mails, "wake");

    expect(text).not.toContain(COPY_NOTE);

    for (const rule of rules) {
      expect(text).toContain(`Held by your filter`);
      expect(text).toContain(rule);
    }
  }
);

it("A wake digest of cc copies keeps the cc note", () => {
  const text = renderDigest(
    "ratking",
    [
      {
        content: "",
        details: {},
        id: "a",
        reason: Reasons.intent({ facts: ["cc"] }),
      },
    ],
    "wake"
  );

  expect(text).toContain(COPY_NOTE);
  expect(text).not.toContain("Held by your filter");
});
