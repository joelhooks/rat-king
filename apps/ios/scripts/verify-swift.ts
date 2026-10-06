import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Schema } from "effect";

import {
  canonical,
  equalBytes,
  open,
} from "../../../packages/envelope/src/envelope.ts";
import {
  Fixture,
  importKeys,
  requestFor,
} from "../../../packages/envelope/test/xcheck-support.ts";
import * as Defs from "../../../packages/lexicon/src/defs.ts";

const SwiftVector = Schema.Struct({
  envelope: Defs.EncryptedEnvelope,
  payload: Defs.SigningPayload,
});

NodeRuntime.runMain(
  Effect.gen(function* verifySwift() {
    const fs = yield* FileSystem.FileSystem;

    const log = yield* fs.readFileString(
      process.argv[2] ?? "/tmp/ratking-ios-swift-test.log"
    );

    const encoded = /RK_SWIFT_VECTOR=(?<vector>[A-Za-z0-9+/=]+)/u.exec(log)
      ?.groups?.vector;

    if (encoded === undefined) {
      throw new Error("Swift vector missing; simulator tests must pass first");
    }

    const wire = yield* Schema.decodeEffect(Schema.fromJsonString(SwiftVector))(
      Buffer.from(encoded, "base64").toString("utf-8")
    );

    const fixture = yield* Schema.decodeEffect(Schema.fromJsonString(Fixture))(
      yield* fs.readFileString(
        new URL(
          "../../../packages/envelope/test/vectors/xcheck/go.json",
          import.meta.url
        ).pathname
      )
    );

    const keys = yield* importKeys(fixture);
    const payload = yield* open(requestFor(wire.envelope, keys));

    if (!equalBytes(canonical(payload), canonical(wire.payload))) {
      throw new Error("Swift-to-TS canonical payload mismatch");
    }

    yield* Console.log(
      "Swift-to-TS HPKE, low-S ES256 and canonical payload: PASS"
    );
  }).pipe(Effect.provide(NodeServices.layer))
);
