import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";

import { BOT_EMAIL, Instance, privateArtifact, violations } from "./rules.ts";

const check = (content: string) => violations({ content, inventory: null });

const inventory = {
  domains: ["network.example"],
  hosts: ["node-a"],
  ips: ["203.0.113.10", "2001:db8::10"],
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

      for (const [category, values] of Object.entries(decoded)) {
        for (const value of values) {
          expect(
            violations({ content: value.toUpperCase(), inventory: decoded })
          ).toContain(`instance-${category}`);
        }
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
