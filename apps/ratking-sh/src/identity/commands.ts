import { Effect, Match } from "effect";

import {
  Account,
  canWrite,
  ClaimHandle,
  PublishKey,
  Register,
  Retire,
  RotateKey,
} from "./account.ts";
import type { VerifiedAdmin } from "./admin.ts";
import { HandleOwnership, ReserveHandle } from "./handle-ownership.ts";

export const applyAdmin = Effect.fn("Identity.applyAdmin")(function* apply({
  commandId,
  did,
  mutation,
}: VerifiedAdmin) {
  const accounts = yield* Account;
  const options = { commandId };

  return yield* Match.value(mutation).pipe(
    Match.tagsExhaustive({
      ClaimHandle: Effect.fn("Identity.claimHandle")(function* claimHandle({
        handle,
      }) {
        const refusal = canWrite(yield* accounts.get(did));

        if (refusal !== null) {
          return yield* refusal;
        }

        const ownership = yield* HandleOwnership;
        yield* ownership.send(handle, new ReserveHandle({ did }), options);

        return yield* accounts.send(did, new ClaimHandle({ handle }), options);
      }),
      PublishKey: ({ key }) => accounts.send(did, new PublishKey(key), options),
      Register: () => accounts.send(did, new Register({}), options),
      Retire: () => accounts.send(did, new Retire({}), options),
      RotateKey: ({ key }) => accounts.send(did, new RotateKey(key), options),
    })
  );
});
