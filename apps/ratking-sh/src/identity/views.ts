/* oxlint-disable eslint/max-classes-per-file -- The two strongly consistent public identity reads share one contract. */
import { Query } from "@alchemy.run/domain";
import { Effect, Layer, Schema } from "effect";

import { Account } from "./account.ts";
import type { AccountState } from "./account.ts";
import { HandleOwnership } from "./handle-ownership.ts";
import { AccountDid, Handle } from "./names.ts";

const Method = Schema.Struct({
  controller: AccountDid,
  id: Schema.String,
  publicKeyMultibase: Schema.String,
  rotatedOutAt: Schema.optionalKey(Schema.Int),
  type: Schema.Literal("Multikey"),
});

export const Document = Schema.Struct({
  "@context": Schema.Array(
    Schema.Union([
      Schema.String,
      Schema.Struct({ rotatedOutAt: Schema.String }),
    ])
  ),
  alsoKnownAs: Schema.Array(Schema.String),
  authentication: Schema.Array(Schema.String),
  id: AccountDid,
  keyAgreement: Schema.Array(Schema.String),
  verificationMethod: Schema.Array(Method),
});

export const documentFor = ({
  did,
  account,
}: {
  readonly did: typeof AccountDid.Type;
  readonly account: AccountState;
}): typeof Document.Type | null => {
  if (account.status === "unregistered") {
    return null;
  }

  const verificationMethod: (typeof Method.Type)[] = [];
  const authentication: string[] = [];
  const keyAgreement: string[] = [];

  for (const key of account.keys) {
    const id = `${did}#${key.purpose}-${key.version}`;

    const method = {
      controller: did,
      id,
      publicKeyMultibase: key.publicKeyMultibase,
      type: "Multikey" as const,
    };

    if (key.rotatedOutAt !== null) {
      verificationMethod.push({ ...method, rotatedOutAt: key.rotatedOutAt });
      continue;
    }

    verificationMethod.push(method);

    switch (key.purpose) {
      case "atproto": {
        verificationMethod.push({ ...method, id: `${did}#atproto` });
        break;
      }

      case "mailbox-auth": {
        authentication.push(id);
        break;
      }

      case "encryption":
      case "kem": {
        keyAgreement.push(id);
        break;
      }

      default: {
        const exhaustive: never = key.purpose;

        return exhaustive;
      }
    }
  }

  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
      { rotatedOutAt: "https://ratking.dev/ns/rotatedOutAt" },
    ],
    alsoKnownAs: account.handle === null ? [] : [`at://${account.handle}`],
    authentication,
    id: did,
    keyAgreement,
    verificationMethod,
  };
};

export class DidDocument extends Query("DidDocument", {
  input: { did: AccountDid },
  success: Schema.NullOr(Document),
}) {}

export class HandleResolution extends Query("HandleResolution", {
  input: { handle: Handle },
  success: Schema.NullOr(AccountDid),
}) {}

export const identityViews = Layer.merge(
  DidDocument.toLayer(
    Effect.gen(function* didDocumentView() {
      const accounts = yield* Account;

      return Effect.fn("Identity.DidDocument")(function* resolve({ did }) {
        return documentFor({ account: yield* accounts.get(did), did });
      });
    })
  ),
  HandleResolution.toLayer(
    Effect.gen(function* handleResolutionView() {
      const accounts = yield* Account;
      const ownership = yield* HandleOwnership;

      return Effect.fn("Identity.HandleResolution")(function* resolve({
        handle,
      }) {
        const { owner } = yield* ownership.get(handle);

        if (owner === null) {
          return null;
        }

        const account = yield* accounts.get(owner);

        return account.handle === handle ? owner : null;
      });
    })
  )
);

export const handleTxtPlan = (
  accounts: Iterable<{
    readonly did: typeof AccountDid.Type;
    readonly account: AccountState;
  }>
) =>
  [...accounts].flatMap(({ did, account }) =>
    account.handle === null
      ? []
      : [
          {
            name: `_atproto.${account.handle}`,
            type: "TXT" as const,
            value: `did=${did}`,
          },
        ]
  );
