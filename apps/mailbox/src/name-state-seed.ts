import { Schema } from "effect";

import { Document } from "./auth.ts";
import { NameState } from "./name-state.ts";

export const seedNameStateNsid = "sh.mschf.ratking.admin.seedNameState";

export const SeedRow = Schema.Struct({
  document: Schema.optionalKey(Document),
  state: NameState,
});

export const SeedBatch = Schema.Struct({
  rows: Schema.Array(SeedRow).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100)
  ),
});
