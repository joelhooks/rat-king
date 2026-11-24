/* oxlint-disable eslint/max-classes-per-file -- The handle reservation and its mutation share one contract. */
import { Aggregate, Command, Event, Rejection } from "@alchemy.run/domain";
import { Schema } from "effect";

import { AccountDid, Handle } from "./names.ts";

export class HandleTaken extends Rejection("HandleTaken") {}

class HandleReserved extends Event("HandleReserved", { did: AccountDid }) {}

export class ReserveHandle extends Command("ReserveHandle", {
  events: [HandleReserved],
  input: { did: AccountDid },
  rejects: [HandleTaken],
  target: Handle,
}) {}

export class HandleOwnership extends Aggregate("HandleOwnership", {
  commands: [ReserveHandle],
  decide: {
    ReserveHandle: ({ owner }, { did }) => {
      if (owner === null) {
        return [new HandleReserved({ did })];
      }

      return owner === did ? [] : new HandleTaken({});
    },
  },
  evolve: {
    HandleReserved: (_, { did }) => ({ owner: did }),
  },
  id: Handle,
  initial: { owner: null },
  state: Schema.Struct({ owner: Schema.NullOr(AccountDid) }),
}) {}
