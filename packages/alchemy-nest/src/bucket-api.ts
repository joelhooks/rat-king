import { Resource } from "alchemy";
import { AdoptPolicy, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Option, Schedule, Schema } from "effect";

import { absent } from "./absent.ts";
import { AbsolutePath, refuse } from "./files.ts";
import { HostShell } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { s3Script } from "./s3-script.ts";

const Props = Schema.Struct({
  config: AbsolutePath,
  endpoint: Schema.Literal("http://127.0.0.1:18333"),
  name: Schema.String.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u)
  ),
  purgeOnDelete: Schema.optionalKey(Schema.Boolean),
  ready: Schema.String,
  region: Schema.Literal("us-east-1"),
});

export type BucketProps = typeof Props.Type;

export interface BucketAttributes {
  readonly endpoint: "http://127.0.0.1:18333";
  readonly name: string;
  readonly region: "us-east-1";
  readonly config: string;
  readonly purgeOnDelete: boolean;
}

export type S3BucketResource = Resource<
  "ObjectStore.Bucket",
  BucketProps,
  BucketAttributes
>;

export const BucketResource = Resource<S3BucketResource>("ObjectStore.Bucket");

const Result = Schema.Struct({ status: Schema.Int, version: Schema.String });

export const bucketRequest = Effect.fn("ObjectStore.request")(function* request(
  shell: Interface,
  props: Pick<BucketProps, "config" | "endpoint" | "name">,
  operation: "read" | "create" | "delete" | "version" | "purge"
) {
  const result = yield* shell.exec([
    "python3",
    "-c",
    s3Script,
    props.config,
    props.endpoint,
    props.name,
    operation,
  ]);

  if (result.code !== 0) {
    return yield* refuse("S3 operation failed; credentials redacted.");
  }

  return yield* Schema.decodeEffect(Schema.fromJsonString(Result))(
    result.stdout
  ).pipe(
    Effect.mapError(() => refuse("Malformed S3 response; values redacted."))
  );
});

const validate = (props: BucketProps) =>
  Schema.decodeEffect(Props)(props).pipe(
    Effect.mapError(() => refuse("Invalid bucket declaration."))
  );

const read = Effect.fn("ObjectStore.read")(function* read(
  shell: Interface,
  props: BucketProps
) {
  yield* validate(props);

  const result = yield* bucketRequest(shell, props, "read").pipe(
    Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 20 })))
  );

  if (result.status === 404) {
    return absent;
  }

  if (result.status !== 200) {
    return yield* refuse("Bucket read failed.");
  }

  const version = yield* bucketRequest(shell, props, "version");

  if (version.status !== 200 || version.version !== "") {
    return yield* refuse("Bucket must have never enabled versioning.");
  }

  return {
    config: props.config,
    endpoint: props.endpoint,
    name: props.name,
    purgeOnDelete: props.purgeOnDelete ?? false,
    region: props.region,
  } satisfies BucketAttributes;
});

export const BucketProvider = () =>
  Provider.effect(
    BucketResource,
    Effect.gen(function* provider() {
      const shell = yield* HostShell;

      return BucketResource.Provider.of({
        delete: Effect.fn("ObjectStore.provider.delete")(function* operation({
          output,
        }) {
          const version = yield* bucketRequest(shell, output, "version");

          if (
            version.status !== 404 &&
            (version.status !== 200 || version.version !== "")
          ) {
            return yield* refuse(
              "Purge refuses a bucket with versioning drift."
            );
          }

          const result = yield* bucketRequest(
            shell,
            output,
            output.purgeOnDelete ? "purge" : "delete"
          );

          if (result.status !== 204 && result.status !== 404) {
            return yield* refuse(
              "Bucket delete refused; drain owned objects first."
            );
          }

          return yield* Effect.void;
        }),
        diff: Effect.fn("ObjectStore.provider.diff")(function* operation({
          news,
          output,
        }) {
          if (!isResolved(news)) {
            return absent;
          }

          yield* validate(news);

          if (
            output !== undefined &&
            (news.name !== output.name ||
              news.endpoint !== output.endpoint ||
              news.config !== output.config)
          ) {
            if ((yield* read(shell, news)) !== undefined) {
              return yield* refuse("Replacement bucket already exists.");
            }

            return { action: "replace", deleteFirst: true };
          }

          return {
            action:
              (yield* read(shell, news)) === undefined ||
              output?.purgeOnDelete !== (news.purgeOnDelete ?? false)
                ? "update"
                : "noop",
          };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("ObjectStore.provider.read")(function* operation({
          olds,
          output,
        }) {
          if (output === undefined && !Schema.is(Props)(olds)) {
            return absent;
          }

          const live = yield* read(shell, olds);

          if (
            live !== undefined &&
            output === undefined &&
            olds.purgeOnDelete === true
          ) {
            return yield* refuse(
              "Existing bucket cannot gain purge authority by adoption."
            );
          }

          return live === undefined || output !== undefined
            ? live
            : Unowned(live);
        }),
        reconcile: Effect.fn("ObjectStore.provider.reconcile")(
          function* operation({ news, output }) {
            yield* validate(news);
            const live = yield* read(shell, news);

            const adopt = yield* Effect.serviceOption(AdoptPolicy).pipe(
              Effect.map(Option.getOrElse(() => false))
            );

            if (live !== undefined) {
              if (
                output === undefined &&
                (!adopt || news.purgeOnDelete === true)
              ) {
                return yield* refuse(
                  "Existing bucket needs explicit adoption."
                );
              }

              return live;
            }

            const created = yield* bucketRequest(shell, news, "create");

            if (created.status !== 200) {
              return yield* refuse("Bucket create failed.");
            }

            const after = yield* read(shell, news);

            if (after === undefined) {
              return yield* refuse("Bucket create failed readback.");
            }

            return after;
          }
        ),
      });
    })
  );
