import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import { celldMemoryMax } from "../../../stacks/nest/config.ts";
import { renderUnits } from "../src/instance-units.ts";
import { NodeSchema } from "../src/inventory-schema.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

it.prop(
  "only an explicitly enabled host changes celld cgroup scope; other units and default bytes stay identical",
  {
    memory: Arbitrary.schema(Schema.Literals(["5G", "8G"])),
    privateCgroupView: Arbitrary.schema(Schema.Boolean),
  },
  ({ memory, privateCgroupView }) => {
    const configured = Schema.decodeSync(NodeSchema)({
      ...host,
      celldMemoryMax: memory,
      privateCgroupView,
    });

    const limits = { celld: { memoryMax: celldMemoryMax(configured) } };
    const baseline = renderUnits(host, {}, limits);
    const actual = renderUnits(configured, {}, limits);

    expect(actual).toHaveLength(baseline.length);

    for (const [index, unit] of actual.entries()) {
      const isCelld = unit.path.endsWith("/rat-king-celld.service");
      const enabled = isCelld && privateCgroupView;

      expect(unit.text.includes("ProtectControlGroups=private\n")).toBe(
        enabled
      );

      if (isCelld) {
        expect(unit.text).toContain(`MemoryMax=${memory}\n`);
      }

      expect(unit.text.replace("ProtectControlGroups=private\n", "")).toBe(
        baseline[index]?.text
      );
    }
  }
);

it.prop(
  "a private cgroup view runs only celld's listener gate outside the sandbox",
  { privateCgroupView: Arbitrary.schema(Schema.Boolean) },
  ({ privateCgroupView }) => {
    const configured = Schema.decodeSync(NodeSchema)({
      ...host,
      privateCgroupView,
    });

    const limits = {
      celld: { restartGate: true },
      seaweed: { restartGate: true },
    };

    const baseline = renderUnits(host, {}, limits);
    const actual = renderUnits(configured, {}, limits);

    for (const [index, unit] of actual.entries()) {
      const isCelld = unit.path.endsWith("/rat-king-celld.service");
      const lines = unit.text.split("\n");
      const post = lines.filter((line) => line.startsWith("ExecStartPost="));

      expect(lines.some((line) => line.startsWith("ExecStartPre=+"))).toBe(
        false
      );

      if (isCelld) {
        expect(post).toHaveLength(1);
        expect(post[0]?.startsWith("ExecStartPost=+/usr/local/bin/node ")).toBe(
          privateCgroupView
        );
      } else {
        expect(post.some((line) => line.startsWith("ExecStartPost=+"))).toBe(
          false
        );
      }

      expect(
        unit.text
          .replace("ProtectControlGroups=private\n", "")
          .replace(
            "ExecStartPost=+/usr/local/bin/node ",
            "ExecStartPost=/usr/local/bin/node "
          )
      ).toBe(baseline[index]?.text);
    }
  }
);

it.prop(
  "inventory memory caps reject disabled, unbounded or malformed quantities",
  {
    malformed: Arbitrary.schema(
      Schema.Union([Schema.Literals(["0", "infinity", "6G\n", 6]), Schema.Null])
    ),
  },
  ({ malformed }) => {
    expect(Schema.is(NodeSchema)({ ...host, celldMemoryMax: malformed })).toBe(
      false
    );
  }
);

it.prop(
  "private cgroup inventory values must be booleans, not truthy coercions",
  {
    malformed: Arbitrary.schema(
      Schema.Union([Schema.Literals(["true", "false", 1]), Schema.Null])
    ),
  },
  ({ malformed }) => {
    expect(
      Schema.is(NodeSchema)({ ...host, privateCgroupView: malformed })
    ).toBe(false);
  }
);
