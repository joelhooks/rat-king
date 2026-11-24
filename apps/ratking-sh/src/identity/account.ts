/* oxlint-disable eslint/max-classes-per-file -- Account's commands, events and rejections share one aggregate contract. */
import { Aggregate, Command, Event, Rejection } from "@alchemy.run/domain";
import { DateTime, Schema } from "effect";

import { Key, PublishedKey } from "./keys.ts";
import { AccountDid, Handle } from "./names.ts";

export class UnknownAccount extends Rejection("UnknownAccount") {}

export class AccountExists extends Rejection("AccountExists") {}

export class Retired extends Rejection("Retired") {}

export class KeyPurposeConflict extends Rejection("KeyPurposeConflict") {}

class Registered extends Event("Registered", {}) {}

class KeyPublished extends Event("KeyPublished", Key.fields) {}

class KeyRotated extends Event("KeyRotated", Key.fields) {}

class HandleClaimed extends Event("HandleClaimed", { handle: Handle }) {}

class AccountRetired extends Event("AccountRetired", {}) {}

export class Register extends Command("Register", {
  events: [Registered],
  rejects: [AccountExists, Retired],
  target: AccountDid,
}) {}

const notWritable = [UnknownAccount, Retired] as const;

const keyRejections = [...notWritable, KeyPurposeConflict] as const;

export class PublishKey extends Command("PublishKey", {
  events: [KeyPublished],
  input: Key.fields,
  rejects: keyRejections,
  target: AccountDid,
}) {}

export class RotateKey extends Command("RotateKey", {
  events: [KeyRotated],
  input: Key.fields,
  rejects: keyRejections,
  target: AccountDid,
}) {}

export class ClaimHandle extends Command("ClaimHandle", {
  events: [HandleClaimed],
  input: { handle: Handle },
  rejects: notWritable,
  target: AccountDid,
}) {}

export class Retire extends Command("Retire", {
  events: [AccountRetired],
  rejects: notWritable,
  target: AccountDid,
}) {}

const AccountSnapshot = Schema.Struct({
  handle: Schema.NullOr(Handle),
  keys: Schema.Array(PublishedKey),
  status: Schema.Literals(["unregistered", "active", "retired"]),
});

export type AccountState = typeof AccountSnapshot.Type;

export const canWrite = (state: AccountState) => {
  switch (state.status) {
    case "unregistered": {
      return new UnknownAccount({});
    }

    case "retired": {
      return new Retired({});
    }

    case "active": {
      return null;
    }

    default: {
      const exhaustive: never = state.status;

      return exhaustive;
    }
  }
};

const decideKey = (
  state: AccountState,
  key: typeof Key.Type,
  rotating: boolean
) => {
  const refusal = canWrite(state);

  if (refusal !== null) {
    return refusal;
  }

  const active = state.keys.some(
    (entry) => entry.purpose === key.purpose && entry.rotatedOutAt === null
  );

  const previouslyUsed = state.keys.some(
    (entry) => entry.publicKeyMultibase === key.publicKeyMultibase
  );

  return active !== rotating || previouslyUsed
    ? new KeyPurposeConflict({})
    : null;
};

const addKey = (
  state: AccountState,
  { publicKeyMultibase, purpose }: typeof Key.Type
) => ({
  ...state,
  keys: [
    ...state.keys,
    {
      publicKeyMultibase,
      purpose,
      rotatedOutAt: null,
      version: state.keys.length + 1,
    },
  ],
});

const markOut = (key: typeof PublishedKey.Type, at: DateTime.Utc) =>
  key.rotatedOutAt === null
    ? { ...key, rotatedOutAt: DateTime.toEpochMillis(at) }
    : key;

export class Account extends Aggregate("Account", {
  commands: [Register, PublishKey, RotateKey, ClaimHandle, Retire],
  decide: {
    ClaimHandle: (state, { handle }) =>
      canWrite(state) ??
      (state.handle === handle ? [] : [new HandleClaimed({ handle })]),
    PublishKey: (state, { publicKeyMultibase, purpose }) =>
      decideKey(state, { publicKeyMultibase, purpose }, false) ?? [
        new KeyPublished({ publicKeyMultibase, purpose }),
      ],
    Register: (state) => {
      if (state.status === "unregistered") {
        return [new Registered({})];
      }

      return state.status === "retired"
        ? new Retired({})
        : new AccountExists({});
    },
    Retire: (state) => canWrite(state) ?? [new AccountRetired({})],
    RotateKey: (state, { publicKeyMultibase, purpose }) =>
      decideKey(state, { publicKeyMultibase, purpose }, true) ?? [
        new KeyRotated({ publicKeyMultibase, purpose }),
      ],
  },
  evolve: {
    AccountRetired: (state, _, { at }): AccountState => ({
      handle: null,
      keys: state.keys.map((key) => markOut(key, at)),
      status: "retired",
    }),
    HandleClaimed: (state, { handle }) => ({ ...state, handle }),
    KeyPublished: addKey,
    KeyRotated: (state, key, { at }) =>
      addKey(
        {
          ...state,
          keys: state.keys.map((entry) =>
            entry.purpose === key.purpose ? markOut(entry, at) : entry
          ),
        },
        key
      ),
    Registered: (state): AccountState => ({ ...state, status: "active" }),
  },
  id: AccountDid,
  initial: { handle: null, keys: [], status: "unregistered" },
  state: AccountSnapshot,
}) {}
