import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { describe, expect } from "vitest";

import {
  BOT_EMAIL,
  Instance,
  instanceLiterals,
  privateArtifact,
  violations,
} from "./rules.ts";

const check = (content: string) => violations({ content, inventory: null });

const inventory = {
  domains: ["network.example"],
  hosts: ["node-a"],
  ips: ["203.0.113.10", "2001:db8::10"],
  s3Credentials: {
    accessKey: ["example", "access"].join("-"),
    secretKey: ["example", "secret"].join("-"),
  },
  secretNames: ["example_credential"],
  sites: ["site-a"],
};

describe("publication rules", () => {
  it("rejects private address ranges and accepts their neighbors", () => {
    for (const [first, start, end] of [
      [10, 0, 255],
      [172, 16, 31],
      [192, 168, 168],
      [100, 64, 127],
    ]) {
      if (first === undefined || start === undefined || end === undefined) {
        throw new Error("Invalid range fixture");
      }

      for (let second = start; second <= end; second += 1) {
        expect(check([first, second, 0, 1].join("."))).toContain("private-ip");
      }

      if (start > 0) {
        expect(check([first, start - 1, 0, 1].join("."))).not.toContain(
          "private-ip"
        );
      }

      if (end < 255) {
        expect(check([first, end + 1, 0, 1].join("."))).not.toContain(
          "private-ip"
        );
      }
    }
  });

  it.prop(
    "rejects private IPv6 literals, including the tailnet ULA range, but not neighboring public literals",
    [
      Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }))
      ),
    ],
    ([end]) => {
      const format = (head: string) => [head, "", end.toString(16)].join(":");

      for (const head of ["fc00", "FD7A", "fdff", "fe80", "febf"]) {
        expect(check(`[${format(head)}]:443`)).toContain("private-ipv6");
      }

      for (const head of ["fbff", "fe00", "fe7f", "fec0", "fc0"]) {
        expect(check(format(head))).not.toContain("private-ipv6");
      }
    }
  );

  it.prop(
    "rejects key-like literals assigned to camelCase credentials but allows placeholders and references",
    [
      Arbitrary.schema(
        Schema.Literals([
          "apiKey",
          "vendorApiKey",
          "secretAccessKey",
          "accessToken",
          "clientSecret",
        ])
      ),
    ],
    ([key]) => {
      for (const value of [
        "3a6f9c82d710eb54".repeat(2),
        ["V9sYk3ab", "2q7BnZM+", "Hx0="].join(""),
        "XKHMEF2C5BGZ6P7N",
        ["AKIA", "63YEH4MKQ2J7WSDN"].join(""),
      ]) {
        expect(check(JSON.stringify({ [key]: value }))).toContain(
          "credential-assignment"
        );
      }

      for (const value of [
        "{{CREDENTIAL_TEMPLATE}}",
        ["$", "{options.placeholder}"].join(""),
        "f".repeat(32),
        "abc-example-n7R0dzft6295",
        "abc-short",
      ]) {
        expect(check(JSON.stringify({ [key]: value }))).not.toContain(
          "credential-assignment"
        );
      }

      for (const reference of ["options.accessKey", "process.env.X", key]) {
        expect(check(`${key}: ${reference}`)).not.toContain(
          "credential-assignment"
        );
      }
    }
  );

  it("rejects generic leaks without copying sensitive fixtures", () => {
    expect(check(["node-a", "network", "ts", "net"].join("."))).toContain(
      "tailnet-domain"
    );
    expect(check(["", "Users", "example", "work"].join("/"))).toContain(
      "home-path"
    );
    expect(check(["person", "example.org"].join("@"))).toContain("email");
    expect(check(["node-a", "internal"].join("."))).toContain("private-host");
    expect(check(["provider", "api", "key"].join("_"))).toContain(
      "secret-name"
    );
  });

  it("allows the bot identity, package versions and property access", () => {
    expect(check(BOT_EMAIL)).toEqual([]);
    expect(check("pnpm@11.3.0 effect@4.0.0-rc.117 node.local.name")).toEqual(
      []
    );
  });

  it.effect("rejects each private literal in any letter case", () =>
    Effect.gen(function* decodeInventory() {
      const decoded = yield* Schema.decodeUnknownEffect(Instance)(inventory);

      for (const [category, values] of instanceLiterals(decoded)) {
        for (const value of values) {
          expect(
            violations({ content: value.toUpperCase(), inventory: decoded })
          ).toContain(`instance-${category}`);
        }
      }

      for (const value of Object.values(inventory.s3Credentials)) {
        expect(violations({ content: value, inventory: decoded })).toContain(
          "instance-s3Credentials"
        );
      }

      expect(
        violations({ content: "node-ab site-ab", inventory: decoded })
      ).toEqual([]);
    })
  );

  it.effect("rejects empty or malformed inventory at the boundary", () =>
    Effect.gen(function* rejectInventory() {
      expect(
        yield* Schema.decodeUnknownEffect(Instance)({}).pipe(Effect.isFailure)
      ).toBe(true);
      expect(
        yield* Schema.decodeUnknownEffect(Instance)({
          ...inventory,
          ips: ["not-an-address"],
        }).pipe(Effect.isFailure)
      ).toBe(true);
      expect(
        yield* Schema.decodeUnknownEffect(Instance)({
          ...inventory,
          hosts: [],
        }).pipe(Effect.isFailure)
      ).toBe(true);
    })
  );

  it("protects ignored private artifacts when staged explicitly", () => {
    for (const name of [
      ".brain/page.svx",
      ".pi/session.json",
      ".agent_sources/private.txt",
      ".alchemy/state.json",
      ".env.local",
      "BRAIN.md",
    ]) {
      expect(privateArtifact(name)).toBe(true);
    }

    expect(privateArtifact(".env.schema")).toBe(false);
    expect(privateArtifact("config/instance.example.json")).toBe(false);
  });
});
