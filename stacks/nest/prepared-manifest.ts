import { Effect, Schema } from "effect";

import { bindings } from "../../apps/mailbox/src/mailbox-declaration.ts";
import {
  BindingName,
  Declaration,
} from "../../packages/alchemy-nest/src/deployment-config.ts";
import { FleetError } from "./stage-config.ts";

export const PreparedManifest = Schema.Struct({
  declaration: Declaration,
  secrets: Schema.Array(BindingName),
  variables: Schema.Array(BindingName),
});

export const mailboxManifest: typeof PreparedManifest.Type = {
  declaration: bindings,
  secrets: [],
  variables: [
    "DELEGATION",
    "DID_DOCUMENTS",
    "HEALTH_READER_DIDS",
    "ISSUER_DID_TEMPLATE",
    "ISSUER_RESERVED",
    "LEASE_RESOLVERS",
    "OBSERVER_DIDS",
    "OPERATOR_DIDS",
    "SERVICE_DID",
  ],
};

const same = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify(left.toSorted()) === JSON.stringify(right.toSorted());

const objects = (declaration: typeof Declaration.Type) =>
  declaration.durable_objects.bindings.map(
    ({ name, class_name }) => `${name}:${class_name}`
  );

export const allowManifest = (candidate: typeof PreparedManifest.Type) => {
  const expected = mailboxManifest.declaration;
  const actual = candidate.declaration;

  return actual.name === expected.name &&
    same(actual.compatibility_flags, expected.compatibility_flags) &&
    same(objects(actual), objects(expected)) &&
    JSON.stringify(actual.migrations) === JSON.stringify(expected.migrations) &&
    same(candidate.secrets, mailboxManifest.secrets) &&
    same(candidate.variables, mailboxManifest.variables)
    ? Effect.void
    : Effect.fail(
        new FleetError({ reason: "ManifestChange: needs legacy ship" })
      );
};
