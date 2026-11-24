/* oxlint-disable eslint/max-classes-per-file -- The read API is the internal projection of this model. */
import { Api, Model } from "@alchemy.run/domain";

import { Account } from "./account.ts";
import { HandleOwnership } from "./handle-ownership.ts";
import { DidDocument, HandleResolution } from "./views.ts";

export class Identity extends Model("Identity", {
  aggregates: [Account, HandleOwnership],
  queries: [DidDocument, HandleResolution],
}) {}

export class IdentityReads extends Api("IdentityReads", {
  model: Identity,
  queries: ["DidDocument", "HandleResolution"],
}) {}
