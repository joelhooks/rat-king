import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import { Console, Effect, FileSystem, Path } from "effect";
import { Command, Flag } from "effect/cli";

import { readCost } from "./cost.ts";
import { drive, mailboxPort } from "./driver.ts";
import { generate, outside, readInputs } from "./identities.ts";
import { MeasureError } from "./model.ts";
import type { Event } from "./model.ts";

const identities = Command.make(
  "identities",
  {
    count: Flag.Int("count").pipe(Flag.withDefault(6)),
    directory: Flag.String("directory"),
  },
  Effect.fn("Measure.identities")(function* identities({ count, directory }) {
    const target = yield* generate(directory, count);

    yield* Console.log(`Created private test inputs in ${target}`);
  })
);

const driver = Command.make(
  "drive",
  {
    baseUrl: Flag.String("base-url"),
    burst: Flag.Int("burst").pipe(Flag.withDefault(1)),
    directory: Flag.String("directory"),
    documents: Flag.String("documents"),
    drainSeconds: Flag.Finite("drain-seconds").pipe(Flag.withDefault(30)),
    output: Flag.String("output"),
    perDay: Flag.Finite("per-day").pipe(Flag.withDefault(12_000)),
    readers: Flag.Int("readers").pipe(Flag.withDefault(6)),
    seconds: Flag.Finite("seconds").pipe(Flag.withDefault(86_400)),
  },
  Effect.fn("Measure.driver")(function* driver(options) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const { inputs, documents } = yield* readInputs(
      options.directory,
      options.documents
    );

    const url = yield* Effect.try({
      catch: () => new MeasureError({ reason: "Invalid endpoint URL" }),
      try: () => new URL(options.baseUrl),
    });

    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/" ||
      options.readers > inputs.readers.length
    ) {
      return yield* new MeasureError({
        reason:
          "Use an HTTP(S) origin without credentials and no more readers than identities",
      });
    }

    const output = path.join(
      yield* outside(path.dirname(path.resolve(options.output))),
      path.basename(options.output)
    );

    yield* fs.writeFileString(output, "", { flag: "wx", mode: 0o600 });

    const emit = (event: Event) =>
      fs
        .writeFileString(output, `${JSON.stringify(event)}\n`, { flag: "a" })
        .pipe(Effect.orDie);

    const port = yield* mailboxPort(url.origin, inputs, documents, emit);

    yield* drive(options, port, emit);

    return yield* Console.log(
      `Measurement complete: ${output} (last JSONL record is the summary)`
    );
  })
);

const analytics = Command.make(
  "cost",
  {
    durationUnit: Flag.Literals("duration-unit", ["gb-seconds"]),
    from: Flag.String("from"),
    namespaces: Flag.String("namespaces"),
    output: Flag.String("output"),
    to: Flag.String("to"),
    worker: Flag.String("worker").pipe(
      Flag.withDefault("rat-king-mailbox-preview")
    ),
  },
  Effect.fn("Measure.analytics")(function* analytics({
    namespaces,
    output,
    ...window
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const target = path.join(
      yield* outside(path.dirname(path.resolve(output))),
      path.basename(output)
    );

    const result = yield* readCost({
      ...window,
      namespaces: namespaces.split(","),
    });

    yield* fs.writeFileString(target, `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    yield* Console.log(`Analytics and estimate saved to ${target}`);
  })
);

const command = Command.make("cf-measure").pipe(
  Command.withSubcommands([identities, driver, analytics])
);

NodeRuntime.runMain(
  Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
    Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer])
  )
);
