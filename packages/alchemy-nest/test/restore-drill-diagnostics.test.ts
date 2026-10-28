import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import { scrubChild } from "../../../stacks/nest/restore-drill-diagnostics.ts";
import { violations } from "../../../tools/fence/rules.ts";

it.prop(
  "the disk class is a case-insensitive word match, not evidence of failure",
  { word: Arbitrary.schema(Schema.Literals(["disk", "DISK", "Disk"])) },
  ({ word }) => {
    const child: Parameters<typeof scrubChild>[0] = {
      argv: ["celld"],
      env: {},
      name: "celld",
      stderr: "",
      stdout: `startup ${word} backend initialized`,
    };

    expect(scrubChild(child, null).stdout).toBe(
      "[diagnostic: object-store disk event]"
    );
    expect(
      scrubChild({ ...child, stdout: "diskless backend initialized" }, null)
        .stdout
    ).toBe("[redacted child output]");
  }
);

it.prop(
  "timeout context retains only approved targets and operation kinds",
  {
    nonce: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1_000_000, minimum: 1 }))
    ),
    port: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1024 }))
    ),
  },
  ({ nonce, port }) => {
    const sensitive = `LEASE_TEST_VALUE_${nonce}`;
    const target = `https://relay.example.invalid:${port}`;
    const requestUrl = new URL(target);

    requestUrl.username = "user";
    requestUrl.password = sensitive;
    requestUrl.pathname = "/cells/private-body";
    requestUrl.searchParams.set("X-Amz-Credential", sensitive);

    const diagnostic = scrubChild(
      {
        argv: ["celld"],
        env: { HOME: sensitive },
        name: "celld",
        stderr: `RequestTimeout op=GetObject endpoint=${requestUrl.toString()} bucket=example-cells`,
        stdout: "",
      },
      null
    );

    expect(diagnostic.stderr).toContain(target);
    expect(diagnostic.stderr).toContain("GetObject");
    expect(diagnostic.stderr).toContain("RequestTimeout");
    expect(diagnostic.stderr).toContain("example-cells");
    expect(diagnostic.stderr).not.toContain(sensitive);
    expect(diagnostic.stderr).not.toContain("private-body");
    expect(diagnostic.stderr).not.toContain("X-Amz");
    expect(diagnostic.stderr).not.toContain("user:");
  }
);

it.prop(
  "diagnostic tails retain classes, never free-form bodies, keys or environment values",
  {
    payload: Arbitrary.schema(Schema.String.check(Schema.isMaxLength(128))),
  },
  ({ payload }) => {
    const sensitive = `NEVER_RETAIN_${payload}`;
    const argv = ["celld", "--listen", "127.0.0.1:1"];

    const diagnostic = scrubChild(
      {
        argv,
        env: { AWS_SECRET_ACCESS_KEY: sensitive, HOME: sensitive },
        name: "celld",
        stderr: `${sensitive}\nError: connection refused ${sensitive}\n`,
        stdout: Array.from({ length: 400 }, () =>
          JSON.stringify({ body: sensitive })
        ).join("\n"),
      },
      null
    );

    expect(diagnostic.argv).toEqual(argv);
    expect(diagnostic.envNames).toEqual(["AWS_SECRET_ACCESS_KEY", "HOME"]);
    expect(diagnostic.stderr).toContain("[diagnostic: connection refused]");
    expect(diagnostic.stdout.split("\n")).toHaveLength(200);

    for (const tail of [diagnostic.stdout, diagnostic.stderr]) {
      expect(tail).not.toContain("NEVER_RETAIN_");
      expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(65_536);
      expect(violations({ content: tail, inventory: null })).toEqual([]);
    }
  }
);
