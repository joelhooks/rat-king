import {
  NodeCrypto,
  NodeHttpClient,
  NodeServices,
} from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, DateTime, Effect, FileSystem, Path, Schema } from "effect";

import {
  layer,
  RatKingMailbox,
} from "../../packages/mailbox-client/src/index.ts";
import { drive, mailboxPort } from "./driver.ts";
import { generate, readInputs } from "./identities.ts";
import { serveLocal } from "./local.ts";
import type { Event } from "./model.ts";

const textBindingLimit = 5100;

it.live(
  "the hosted bundle serves leases, sends, deliveries and acks under workerd with documents over the text binding cap",
  () =>
    Effect.gen(function* hostedUnderWorkerd() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "cf-measure-local-",
      });

      const target = path.join(directory, "inputs");

      yield* generate(target, 8);

      const { inputs, documents } = yield* readInputs(
        target,
        path.join(target, "documents.json")
      );

      const text = yield* fs.readFileString(
        path.join(target, "documents.json")
      );

      expect(text.length).toBeGreaterThan(textBindingLimit);

      const origin = yield* serveLocal(inputs, text);
      const events: Event[] = [];

      const port = yield* mailboxPort(
        origin,
        inputs,
        documents,
        (event: Event) =>
          Effect.sync(() => {
            events.push(event);
          })
      );

      yield* drive(
        {
          burst: 2,
          drainSeconds: 5,
          perDay: 8_640_000,
          readers: 4,
          seconds: 12,
        },
        port,
        (event) =>
          Effect.sync(() => {
            events.push(event);
          })
      ).pipe(Effect.provide(NodeCrypto.layer));

      const spare = inputs.readers.at(4);

      if (spare === undefined) {
        throw new Error("Expected a spare reader identity");
      }

      const now = yield* Clock.currentTimeMillis;

      const released = yield* RatKingMailbox.pipe(
        Effect.flatMap((mailbox) =>
          mailbox.lease
            .acquire({
              did: spare.did,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)),
              harness: {
                $type: "sh.mschf.ratking.runtime.lease#pi",
                sessionId: "spare",
              },
            })
            .pipe(
              Effect.flatMap((lease) =>
                mailbox.lease.release({
                  did: spare.did,
                  generation: lease.generation,
                  leaseId: lease.leaseId,
                })
              )
            )
        ),
        Effect.provide(
          layer({
            documents,
            endpoint: origin,
            identity: spare,
            serviceDid: inputs.service.did,
          })
        ),
        Effect.result
      );

      expect(released._tag).toBe("Success");

      const summary = events.at(-1);
      expect(summary).toMatchObject({ errors: {}, kind: "summary" });

      const totals = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          ackMs: Schema.Struct({ count: Schema.Number }),
          attempted: Schema.Number,
          incomplete: Schema.Number,
        })
      )(summary);

      expect(totals.attempted).toBeGreaterThan(20);
      expect(totals.incomplete).toBeLessThanOrEqual(2);
      expect(totals.ackMs.count).toBeGreaterThanOrEqual(totals.attempted - 2);
    }).pipe(
      Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer]),
      Effect.scoped
    ),
  60_000
);
