// @effect-diagnostics nodeBuiltinImport:off -- Compare inert decoded manifest objects, not JSON key order.
import { isDeepStrictEqual } from "node:util";

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

export const manifestChange = () =>
  new FleetError({ reason: "ManifestChange: needs legacy ship" });

export const allowManifest = (candidate: typeof PreparedManifest.Type) =>
  isDeepStrictEqual(
    {
      ...candidate,
      declaration: {
        ...candidate.declaration,
        compatibility_date: mailboxManifest.declaration.compatibility_date,
      },
    },
    mailboxManifest
  )
    ? Effect.void
    : Effect.fail(manifestChange());
