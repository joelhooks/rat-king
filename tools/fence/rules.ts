// @effect-diagnostics nodeBuiltinImport:off -- Node tooling validates IP literals at the publication boundary.
import { isIP } from "node:net";

import { Schema } from "effect";

const nonemptyValues = Schema.NonEmptyArray(
  Schema.NonEmptyString.check(Schema.isPattern(/\S/u))
);

export const Instance = Schema.Struct({
  domains: nonemptyValues,
  hosts: nonemptyValues,
  ips: Schema.NonEmptyArray(
    Schema.String.check(Schema.makeFilter((value) => isIP(value) !== 0))
  ),
  secretNames: nonemptyValues,
  sites: nonemptyValues,
});

export type PrivateInstance = typeof Instance.Type;

export const BOT_EMAIL = "286405550+shitratgit[bot]@users.noreply.github.com";

const privateIp = (value: string): boolean => {
  if (isIP(value) !== 4) {
    return false;
  }

  const [first, second] = value.split(".").map(Number);

  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127)
  );
};

const escaped = (value: string) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const violations = ({
  content,
  inventory,
}: {
  readonly content: string;
  readonly inventory: PrivateInstance | null;
}): readonly string[] => {
  const found = new Set<string>();

  if (/\/Users\/[A-Za-z0-9_.-]+(?:\/|\b)/u.test(content)) {
    found.add("home-path");
  }

  if (/(?:[a-z0-9*-]+\.)+ts\.net\b/iu.test(content)) {
    found.add("tailnet-domain");
  }

  if (
    /(?<![\w.])[a-z0-9][a-z0-9-]*\.(?:local|internal|lan)(?![\w.])/iu.test(
      content
    )
  ) {
    found.add("private-host");
  }

  if (
    /\b(?:agent[-_]secrets[:/ ]+|[a-z][a-z0-9_]*_(?:api_key|secret|token|password))\b/iu.test(
      content
    )
  ) {
    found.add("secret-name");
  }

  for (const match of content.matchAll(
    /[A-Za-z0-9.!#$%&*+/=?^_`{|}~[\]-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9])/gu
  )) {
    if (match[0] !== BOT_EMAIL) {
      found.add("email");
    }
  }

  for (const match of content.matchAll(
    /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/gu
  )) {
    if (privateIp(match[0])) {
      found.add("private-ip");
    }
  }

  if (inventory !== null) {
    for (const [category, values] of Object.entries(inventory)) {
      for (const value of values) {
        if (
          new RegExp(`(?<![\\w-])${escaped(value)}(?![\\w-])`, "iu").test(
            content
          )
        ) {
          found.add(`instance-${category}`);
        }
      }
    }
  }

  return [...found].toSorted();
};

export const privateArtifact = (name: string): boolean =>
  /(?:^|\/)(?:\.brain|\.pi|\.agent_sources|\.agent-sources|\.alchemy|\.fence-tmp)(?:\/|$)/u.test(
    name
  ) ||
  /(?:^|\/)BRAIN\.md$/u.test(name) ||
  (/(?:^|\/)\.env(?:$|\.)/u.test(name) && !name.endsWith(".env.schema"));
