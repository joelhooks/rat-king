import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";

import { Instance, violations } from "../../tools/fence/rules.ts";
import type { PrivateInstance } from "../../tools/fence/rules.ts";

const Child = Schema.Struct({
  argv: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  name: Schema.Literals(["celld", "weed"]),
  stderr: Schema.String,
  stdout: Schema.String,
});

const Snapshot = Schema.Struct({
  children: Schema.Array(Child),
  inventory: Schema.String,
});

const diskWordNotFailurePattern = /\bdisk\b/iu;

const classes: readonly (readonly [RegExp, string])[] = [
  [/connection refused/iu, "connection refused"],
  [/connection reset/iu, "connection reset"],
  [/timed? out|timeout/iu, "connection or operation timed out"],
  [/no (?:free|writable) volumes?/iu, "no writable object-store volumes"],
  [/assign/iu, "object-store volume assignment event"],
  [/grow/iu, "object-store volume growth event"],
  [/read[ _-]?only/iu, "object-store read-only event"],
  [diskWordNotFailurePattern, "object-store disk event"],
  [/no such file|not found/iu, "required resource not found"],
  [/permission denied|access denied|forbidden/iu, "access denied"],
  [/address already in use/iu, "listen address already in use"],
  [
    /unrecognized|unknown argument|unexpected argument/iu,
    "unrecognized command argument",
  ],
  [
    /missing.*binding|binding.*missing/iu,
    "required deployment binding missing",
  ],
  [/invalid.*binding|binding.*invalid/iu, "invalid deployment binding"],
  [
    /credential|authorization|unauthorized/iu,
    "authentication configuration rejected",
  ],
  [/dispatch failure|error sending request/iu, "HTTP request dispatch failed"],
  [
    /bucket.*(?:missing|exist)|NoSuchBucket/u,
    "required object-store bucket missing",
  ],
  [
    /invalid.*(?:integer|digit|number|duration)|must be.*(?:positive|nonzero)/iu,
    "invalid numeric configuration",
  ],
  [/panic|panicked/iu, "child process panicked"],
  [/invalid.*config|config.*invalid/iu, "invalid startup configuration"],
];

const timeoutContext = (line: string) => {
  const endpoints = new Set<string>();
  const buckets = new Set<string>();
  const operations = new Set<string>();
  const errorKinds = new Set<string>();

  if (
    !/(?:body|payload|envelope|secret|token|authorization|password)["']?\s*[=:]/iu.test(
      line
    )
  ) {
    for (const match of line.matchAll(
      /(?<address>(?:https?|s3):\/\/[^\s"'<>]+)/giu
    )) {
      const address = match.groups?.address;

      if (address !== undefined) {
        try {
          const url = new URL(address);

          const safeHost = !url.hostname
            .split(".")
            .some((label) => label.length > 32);

          if (safeHost) {
            endpoints.add(`${url.protocol}//${url.host}`);

            if (url.protocol === "s3:") {
              buckets.add(url.hostname);
            }
          }
        } catch {
          endpoints.add("[invalid endpoint]");
        }
      }
    }

    const withoutUrls = line.replaceAll(/(?:https?|s3):\/\/[^\s"'<>]+/giu, " ");

    for (const match of withoutUrls.matchAll(
      /(?<address>(?:(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.ts\.net):\d{1,5})/giu
    )) {
      const address = match.groups?.address;

      if (address !== undefined) {
        endpoints.add(address);
      }
    }

    for (const match of line.matchAll(
      /\bbucket["']?\s*[=:]\s*["']?(?<bucket>[a-z0-9][a-z0-9-]{1,61}[a-z0-9])\b/giu
    )) {
      const bucket = match.groups?.bucket;

      if (bucket !== undefined) {
        buckets.add(bucket);
      }
    }
  }

  for (const operation of [
    "GetObject",
    "PutObject",
    "HeadObject",
    "ListObjectsV2",
    "DeleteObject",
    "GetBucketLocation",
    "CreateMultipartUpload",
    "UploadPart",
    "CompleteMultipartUpload",
    "AbortMultipartUpload",
    "GET",
    "POST",
    "PUT",
    "HEAD",
    "DELETE",
    "renew_node_lease",
    "activate",
    "read",
    "write",
  ]) {
    if (new RegExp(`\\b${operation}\\b`, "u").test(line)) {
      operations.add(operation);
    }
  }

  for (const kind of [
    "Timeout",
    "TimedOut",
    "RequestTimeout",
    "ConnectTimeout",
    "RemoteDisconnected",
    "ConnectionRefused",
    "ConnectionReset",
    "SlowDown",
  ]) {
    if (line.includes(kind)) {
      errorKinds.add(kind);
    }
  }

  return {
    buckets: [...buckets].toSorted(),
    endpoints: [...endpoints].toSorted(),
    errorKinds: [...errorKinds].toSorted(),
    operations: [...operations].toSorted(),
  };
};

export const scrubTail = (
  raw: string,
  inventory: PrivateInstance | null
): string => {
  const lines = raw.split(/\r?\n/u);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  const normalized = lines.slice(-200).map((line) => {
    const reason = classes.find(([pattern]) => pattern.test(line))?.[1];

    const diagnostic =
      reason === undefined
        ? "[redacted child output]"
        : `[diagnostic: ${reason}]`;

    if (violations({ content: diagnostic, inventory }).length !== 0) {
      return "[redacted by fence]";
    }

    return reason === "connection or operation timed out"
      ? `${diagnostic} ${JSON.stringify(timeoutContext(line))}`
      : diagnostic;
  });

  const retained: string[] = [];
  let bytes = 0;

  for (const line of normalized.toReversed()) {
    const size = new TextEncoder().encode(line).length + 1;

    if (bytes + size > 65_536) {
      break;
    }

    retained.unshift(line);
    bytes += size;
  }

  return retained.join("\n");
};

export const scrubChild = (
  child: typeof Child.Type,
  inventory: PrivateInstance | null
) => ({
  argv: child.argv,
  envNames: Object.keys(child.env).toSorted(),
  name: child.name,
  policy:
    "fixed classes; timeout-only endpoint/bucket/operation/error metadata; no free-form output",
  stderr: scrubTail(child.stderr, inventory),
  stdout: scrubTail(child.stdout, inventory),
});

export const diagnosticsMain = Effect.gen(function* retainDiagnostics() {
  const fs = yield* FileSystem.FileSystem;
  const [input, output] = process.argv.slice(2);

  if (input === undefined || output === undefined) {
    return yield* Effect.die("Diagnostic input and output paths required");
  }

  const snapshot = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Snapshot)
  )(yield* fs.readFileString(input));

  const inventory = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Instance)
  )(yield* fs.readFileString(snapshot.inventory));

  yield* fs.writeFileString(
    output,
    JSON.stringify({
      children: snapshot.children.map((child) => scrubChild(child, inventory)),
      maxBytesPerStream: 65_536,
      maxLinesPerStream: 200,
    })
  );
  yield* fs.chmod(output, 0o600);

  return yield* Effect.void;
}).pipe(Effect.provide(NodeServices.layer));
