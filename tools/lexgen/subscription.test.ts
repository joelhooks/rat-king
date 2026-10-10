import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Result, Schema } from "effect";

import * as Subscribe from "../../packages/lexicon/src/mailbox.subscribe.ts";

const samples = Arbitrary.schema(
  Schema.Struct({
    future: Schema.String,
    generation: Subscribe.Params.schema.fields.generation,
    seq: Subscribe.Notice.schema.fields.seq,
    token: Subscribe.Auth.schema.fields.token,
  })
);

it.effect.prop(
  "subscription params and open notice messages round-trip losslessly",
  { sample: samples },
  ({ sample }) =>
    Effect.gen(function* roundTrip() {
      const params = yield* Schema.decodeUnknownEffect(Subscribe.Params)({
        generation: sample.generation,
        leaseId: "3jzfcijpj2z2b",
        recipientDid: "did:web:recipient.example.invalid",
      });

      expect(
        yield* Subscribe.decodeParams(yield* Subscribe.encodeParams(params))
      ).toEqual(params);

      for (const raw of [
        { $type: "sh.mschf.ratking.mailbox.subscribe#notice", seq: sample.seq },
        {
          $type: "sh.mschf.ratking.mailbox.subscribe#future",
          future: sample.future,
        },
      ]) {
        const message = yield* Schema.decodeUnknownEffect(Subscribe.Message)(
          raw
        );

        expect(
          yield* Schema.decodeEffect(Subscribe.Message)(
            yield* Schema.encodeEffect(Subscribe.Message)(message)
          )
        ).toEqual(raw);
      }

      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Subscribe.Message)({
            $type: "sh.mschf.ratking.mailbox.subscribe#notice",
            seq: sample.token,
          }).pipe(Effect.result)
        )
      ).toBe(true);
    })
);
