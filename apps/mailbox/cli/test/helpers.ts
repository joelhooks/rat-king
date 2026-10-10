import * as Defs from "@rat-king/lexicon/defs";
import { Identity } from "@rat-king/mailbox-client";
import { Effect, Schema } from "effect";

import { generateKey, publicDocument } from "../provision.ts";

export const identity = (did: string) =>
  Effect.gen(function* createIdentity() {
    return yield* Schema.decodeUnknownEffect(Identity)({
      agreement: yield* generateKey("ECDH"),
      did,
      signing: yield* generateKey("ECDSA"),
    });
  });

export const document = (value: typeof Identity.Type) =>
  Schema.decodeUnknownEffect(Schema.toType(Defs.DidDocument))(
    publicDocument(value)
  );
