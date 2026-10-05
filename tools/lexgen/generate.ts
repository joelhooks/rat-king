// @effect-diagnostics nodeBuiltinImport:off -- Node tooling hashes exact source bytes.
import { createHash } from "node:crypto";

import { Lexicons, parseLexiconDoc } from "@atproto/lexicon";
import type {
  LexiconDoc,
  LexInteger,
  LexString,
  LexUserType,
  LexXrpcBody,
  LexXrpcParameters,
  LexXrpcSubscription,
} from "@atproto/lexicon";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { format } from "oxfmt";

import formatConfig from "../../oxfmt.config.ts";

export class GenerationError extends Schema.TaggedError<GenerationError>()(
  "GenerationError",
  { reason: Schema.String }
) {}

const version = "0.1.0";

const namespace = "sh.mschf.ratking.";

const quote = (value: string) => JSON.stringify(value);

const number = (value: number) =>
  String(value).replaceAll(/\B(?=(?:\d{3})+(?!\d))/gu, "_");

const sortedString = (field: LexString) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(field).toSorted(([a], [b]) => a.localeCompare(b))
    )
  );

const symbol = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

const filename = (id: string) => id.slice(namespace.length);

const moduleName = (id: string) =>
  id.slice(namespace.length).split(".").map(symbol).join("");

type Field =
  | LexUserType
  | { readonly type: "ref"; readonly ref: string }
  | {
      readonly type: "union";
      readonly refs: readonly string[];
      readonly closed?: boolean | undefined;
    };

const unsupported: (reason: string) => never = (reason) => {
  throw new GenerationError({ reason });
};

const resolve = (id: string, ref: string) => {
  const qualified = ref.startsWith("#") ? `${id}${ref}` : ref;
  const [document, name = "main"] = qualified.split("#");

  if (document === undefined || document === "") {
    return unsupported("Empty reference");
  }

  return {
    document,
    name,
    tag: name === "main" ? document : `${document}#${name}`,
  };
};

const integerExpression = (field: LexInteger) => {
  if (
    (field.maximum ?? Number.MAX_SAFE_INTEGER) > Number.MAX_SAFE_INTEGER ||
    (field.minimum ?? Number.MIN_SAFE_INTEGER) < Number.MIN_SAFE_INTEGER
  ) {
    return unsupported("Integer range exceeds the lossless safe-integer codec");
  }

  let base = "Schema.Int";

  if (field.const === undefined) {
    if (field.enum !== undefined) {
      base = `Schema.Literals(${JSON.stringify(field.enum)})`;
    }
  } else {
    base = `Schema.Literal(${number(field.const)})`;
  }

  return `${base}.check(Schema.isGreaterThanOrEqualTo(${number(field.minimum ?? Number.MIN_SAFE_INTEGER)}), Schema.isLessThanOrEqualTo(${number(field.maximum ?? Number.MAX_SAFE_INTEGER)}))`;
};

const stringExpression = (field: LexString) => {
  const base = `Runtime.lexString(${sortedString(field)})`;

  if (field.const !== undefined) {
    return `${base}.pipe(Schema.decodeTo(Schema.Literal(${quote(field.const)})))`;
  }

  if (field.enum !== undefined) {
    return `${base}.pipe(Schema.decodeTo(Schema.Literals(${JSON.stringify(field.enum)})))`;
  }

  if (field.format !== undefined) {
    return `${base}.pipe(Schema.brand(${quote(`Lexicon:${field.format}`)}))`;
  }

  return base;
};

const bodyExpression = (
  body: LexXrpcBody | undefined,
  expression: (field: Field) => string
) => {
  if (body === undefined) {
    return "Schema.Undefined";
  }

  if (body.encoding !== "application/json" || body.schema === undefined) {
    return unsupported("Only declared JSON XRPC bodies are supported");
  }

  return expression(body.schema);
};

const bytesExpression = (field: Extract<Field, { type: "bytes" }>) =>
  `Runtime.Bytes.check(Schema.makeFilter((value) => value.length >= ${number(field.minLength ?? 0)} && value.length <= ${number(field.maxLength ?? Number.MAX_SAFE_INTEGER)}, { expected: "byte length constraints" }))`;

const blobExpression = (field: Extract<Field, { type: "blob" }>) => {
  const accept = field.accept ?? ["*/*"];

  return `Runtime.Blob.check(Schema.makeFilter((value) => value.ref.code === 0x55 && value.size <= ${number(field.maxSize ?? Number.MAX_SAFE_INTEGER)} && ${JSON.stringify(accept)}.some((mime) => mime === "*/*" || mime === value.mimeType || (mime.endsWith("/*") && value.mimeType.startsWith(mime.slice(0, -1)))), { expected: "blob MIME, raw CID and size constraints" }))`;
};

const arrayExpression = (
  field: Extract<Field, { type: "array" }>,
  item: string
) =>
  `Schema.Array(${item}).check(Schema.isMinLength(${number(field.minLength ?? 0)}), Schema.isMaxLength(${number(field.maxLength ?? Number.MAX_SAFE_INTEGER)}))`;

const renderer = (docs: readonly LexiconDoc[], doc: LexiconDoc) => {
  const imports = new Set<string>();
  const dependencies = new Set<string>();

  const definition = (id: string, name: string) => {
    const found = docs.find((candidate) => candidate.id === id)?.defs[name];

    if (found === undefined) {
      return unsupported(`Unresolved reference: ${id}#${name}`);
    }

    return found;
  };

  const reference = (ref: string, contextId: string) => {
    const target = resolve(contextId, ref);
    definition(target.document, target.name);

    if (target.document === doc.id) {
      dependencies.add(target.name);

      return symbol(target.name);
    }

    imports.add(target.document);

    return `${moduleName(target.document)}.${symbol(target.name)}`;
  };

  const objectExpression = (
    field: Extract<Field, { type: "object" }>,
    tag: string | undefined,
    contextId: string,
    render: (field: Field, tag: string | undefined, contextId: string) => string
  ): string => {
    const fields = Object.entries(field.properties)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        let schema = render(value, undefined, contextId);

        if (field.nullable?.includes(key) === true) {
          schema = `Schema.NullOr(${schema})`;
        }

        if (field.required?.includes(key) !== true) {
          schema = `Schema.optionalKey(${schema})`;
        }

        return `${quote(key)}: ${schema}`;
      });

    if (tag !== undefined) {
      fields.unshift(`$type: Schema.Literal(${quote(tag)})`);
    }

    return `Schema.StructWithRest(Schema.Struct({${fields.join(",\n")}}), [Schema.Record(Schema.String, Runtime.Data)])`;
  };

  const unionExpression = (
    field: Extract<Field, { type: "union" }>,
    contextId: string,
    render: (field: Field, tag: string | undefined, contextId: string) => string
  ): string => {
    const tags: string[] = [];

    const variants = field.refs.map((ref) => {
      const target = resolve(contextId, ref);
      tags.push(target.tag);
      const found = definition(target.document, target.name);

      if (found.type !== "object" && found.type !== "record") {
        return unsupported("Union reference must name an object or record");
      }

      return render(
        found.type === "record" ? found.record : found,
        target.tag,
        target.document
      );
    });

    if (field.closed !== true) {
      variants.push(
        `Runtime.TaggedMap.check(Schema.makeFilter((value) => !${JSON.stringify(tags)}.includes(value.$type), { expected: "unknown union tag only" }))`
      );
    }

    return `Schema.Union([${variants.join(",\n")}])`;
  };

  const expression = (
    field: Field,
    tag?: string,
    contextId: string = doc.id
  ): string => {
    switch (field.type) {
      case "boolean": {
        return field.const === undefined
          ? "Schema.Boolean"
          : `Schema.Literal(${field.const})`;
      }

      case "integer": {
        return integerExpression(field);
      }

      case "string": {
        return stringExpression(field);
      }

      case "bytes": {
        return bytesExpression(field);
      }

      case "cid-link": {
        return "Runtime.Link";
      }

      case "blob": {
        return blobExpression(field);
      }

      case "unknown": {
        return "Runtime.DataMap";
      }

      case "ref": {
        return reference(field.ref, contextId);
      }

      case "array": {
        return arrayExpression(
          field,
          expression(field.items, undefined, contextId)
        );
      }

      case "object": {
        return objectExpression(field, tag, contextId, expression);
      }

      case "union": {
        return unionExpression(field, contextId, expression);
      }

      case "record": {
        return expression(field.record, contextId, contextId);
      }

      case "permission-set":
      case "procedure":
      case "query":
      case "subscription":
      case "token": {
        return unsupported(`Unsupported Lexicon type: ${field.type}`);
      }

      default: {
        return unsupported("Unrecognized Lexicon type");
      }
    }
  };

  return { dependencies, expression, imports };
};

const queryPrimitive = (
  field: LexXrpcParameters["properties"][string]
): string => {
  switch (field.type) {
    case "string": {
      return "Schema.String";
    }

    case "integer": {
      return "Schema.FiniteFromString";
    }

    case "boolean": {
      return "Query.BooleanFromQuery";
    }

    case "array": {
      return `Schema.Array(${queryPrimitive(field.items)})`;
    }

    case "unknown": {
      return unsupported("Unknown query parameters are not supported");
    }

    default: {
      return unsupported("Unrecognized query parameter");
    }
  }
};

const queryDeclarations = (parameters: LexXrpcParameters | undefined) => {
  if (parameters === undefined) {
    return "";
  }

  const fields = Object.entries(parameters.properties)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const primitive = queryPrimitive(value);

      const schema =
        parameters.required?.includes(key) === true
          ? primitive
          : `Schema.optionalKey(${primitive})`;

      return `${quote(key)}: ${schema}`;
    });

  return `export const ParamsFromQuery = Schema.StructWithRest(Schema.Struct({ ${fields.join(",")} }), [Schema.Record(Schema.String, Runtime.Data)]).pipe(Schema.decodeTo(Params));
export const encodeParams = Effect.fn("lexicon.encodeParams")(function* encodeParams(params: ParamsValue) {
  return Query.entries(yield* Schema.decodeUnknownEffect(Query.Params)(yield* Schema.encodeEffect(ParamsFromQuery)(params)));
});
export const decodeParams = Effect.fn("lexicon.decodeParams")(function* decodeParams(entries: readonly (readonly [string, string])[]) {
  return yield* Schema.decodeUnknownEffect(ParamsFromQuery)(Query.parameters(entries));
});`;
};

const recordMetadata = (def: LexUserType, id: string) => {
  if (def.type !== "record") {
    return "";
  }

  return `export const RecordMetadata = { collection: ${quote(id)}, key: ${quote(def.key ?? "any")} } as const;`;
};

const knownValuesDeclarations = (def: LexUserType, binding: string) => {
  if (def.type !== "string" || def.knownValues === undefined) {
    return "";
  }

  return `export const ${binding}KnownValues = ${JSON.stringify(def.knownValues)} as const;
export type ${binding}Known = typeof ${binding}KnownValues[number];
export const is${binding}Known = (value: ${binding}Value): value is ${binding}Known => ${binding}KnownValues.some((known) => known === value);`;
};

const subscriptionDeclaration = (
  def: LexXrpcSubscription,
  id: string,
  expression: (field: Field) => string
) => {
  const params = def.parameters
    ? expression({ ...def.parameters, type: "object" })
    : "Schema.Undefined";

  if (def.message?.schema === undefined) {
    unsupported("Subscription must declare a message union");
  }

  return `export const Params = ${params};
export type ParamsValue = typeof Params.Type;
export const Message = ${expression(def.message.schema)};
export type MessageValue = typeof Message.Type;
${queryDeclarations(def.parameters)}
export const KnownErrors = ${JSON.stringify(def.errors?.map((error) => error.name) ?? [])} as const;
export type KnownError = typeof KnownErrors[number];
export const isKnownError = (value: string): value is KnownError => KnownErrors.some((name) => name === value);
export const Method = { nsid: ${quote(id)}, params: Params, path: ${quote(`/xrpc/${id}`)} } as const;`;
};

const hasParameters = (doc: LexiconDoc) =>
  Object.values(doc.defs).some(
    (def) =>
      (def.type === "query" ||
        def.type === "procedure" ||
        def.type === "subscription") &&
      def.parameters !== undefined
  );

const parameterImports = (doc: LexiconDoc) =>
  hasParameters(doc)
    ? 'import { Effect, Schema } from "effect";\nimport * as Query from "./query.ts";'
    : 'import { Schema } from "effect";\n';

const renderDocument = (docs: readonly LexiconDoc[], doc: LexiconDoc) => {
  const render = renderer(docs, doc);
  const declarations = new Map<string, string>();
  const dependencyGraph = new Map<string, string[]>();

  for (const [name, def] of Object.entries(doc.defs).toSorted(([a], [b]) =>
    a.localeCompare(b)
  )) {
    render.dependencies.clear();
    const binding = symbol(name);

    if (def.type === "query" || def.type === "procedure") {
      const params = def.parameters
        ? render.expression({ ...def.parameters, type: "object" })
        : "Schema.Undefined";

      const errors = def.errors?.map((error) => error.name) ?? [];

      const defaults = Object.fromEntries(
        Object.entries(def.parameters?.properties ?? {}).flatMap(
          ([key, value]) =>
            "default" in value && value.default !== undefined
              ? [[key, value.default]]
              : []
        )
      );

      declarations.set(
        name,
        `export const Params = ${params};
export type ParamsValue = typeof Params.Type;
export const Input = ${bodyExpression(def.type === "procedure" ? def.input : undefined, render.expression)};
export type InputValue = typeof Input.Type;
export const Output = ${bodyExpression(def.output, render.expression)};
export type OutputValue = typeof Output.Type;
${queryDeclarations(def.parameters)}
export const ErrorBody = Runtime.XrpcErrorBody;
export type ErrorBodyValue = typeof ErrorBody.Type;
export const KnownErrors = ${JSON.stringify(errors)} as const;
export type KnownError = typeof KnownErrors[number];
export const isKnownError = (value: string): value is KnownError => KnownErrors.some((name) => name === value);
export const Method = { defaults: ${JSON.stringify(defaults)}, error: ErrorBody, input: Input, inputEncoding: ${quote(def.type === "procedure" ? (def.input?.encoding ?? "") : "")}, method: ${quote(def.type === "query" ? "GET" : "POST")}, nsid: ${quote(doc.id)}, output: Output, outputEncoding: ${quote(def.output?.encoding ?? "")}, params: Params, path: ${quote(`/xrpc/${doc.id}`)} } as const;`
      );
    } else if (def.type === "subscription") {
      declarations.set(
        name,
        subscriptionDeclaration(def, doc.id, render.expression)
      );
    } else if (def.type === "token") {
      declarations.set(
        name,
        `export const ${binding} = ${quote(resolve(doc.id, `#${name}`).tag)};`
      );
    } else {
      declarations.set(
        name,
        `export const ${binding} = ${render.expression(def)};
export type ${binding}Value = typeof ${binding}.Type;
${recordMetadata(def, doc.id)}
${knownValuesDeclarations(def, binding)}`
      );
    }

    dependencyGraph.set(name, [...render.dependencies]);
  }

  const emitted = new Set<string>();
  const active = new Set<string>();
  const output: string[] = [];

  const emit = (name: string) => {
    if (emitted.has(name)) {
      return;
    }

    if (active.has(name)) {
      unsupported(
        `Recursive definition requires an explicit recursive codec: ${doc.id}#${name}`
      );
    }

    active.add(name);

    for (const dependency of dependencyGraph.get(name) ?? []) {
      emit(dependency);
    }

    const value = declarations.get(name);

    if (value === undefined) {
      unsupported(`Missing declaration ${name}`);
    }

    output.push(value.replaceAll(/\n(?=export )/gu, "\n\n"));
    active.delete(name);
    emitted.add(name);
  };

  for (const name of declarations.keys()) {
    emit(name);
  }

  return `${parameterImports(doc)}
import * as Runtime from "./runtime.ts";
${[...render.imports]
  .toSorted()
  .map((id) => `import * as ${moduleName(id)} from "./${filename(id)}.ts";`)
  .join("\n")}

${output.join("\n\n")}\n`;
};

export const walk = Effect.fn("lexgen.walk")(function* walk(
  directory: string
): Effect.fn.Return<
  string[],
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output: string[] = [];

  for (const name of (yield* fs.readDirectory(directory)).toSorted()) {
    const location = path.join(directory, name);

    if ((yield* fs.stat(location)).type === "Directory") {
      output.push(...(yield* walk(location)));
    } else {
      output.push(location);
    }
  }

  return output;
});

export const generate = Effect.fn("lexgen.generate")(function* generate({
  root,
  write,
}: {
  readonly root: string;
  readonly write: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sources = (yield* walk(path.join(root, "lexicons/sh"))).filter((file) =>
    file.endsWith(".json")
  );

  if (sources.length === 0) {
    return yield* new GenerationError({ reason: "No Lexicon documents" });
  }

  const digest = createHash("sha256");
  const docs: LexiconDoc[] = [];

  for (const source of sources) {
    const bytes = yield* fs.readFile(source);
    digest.update(path.relative(root, source).split(path.sep).join("/"));
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");

    const doc = yield* Effect.try({
      catch: () =>
        new GenerationError({
          reason: `Invalid Lexicon document: ${path.relative(root, source)}`,
        }),
      try: () => parseLexiconDoc(JSON.parse(new TextDecoder().decode(bytes))),
    });

    if (
      !doc.id.startsWith(namespace) ||
      path
        .relative(path.join(root, "lexicons"), source)
        .split(path.sep)
        .join("/") !== `${doc.id.replaceAll(".", "/")}.json`
    ) {
      return yield* new GenerationError({
        reason: "NSID does not match source path",
      });
    }

    docs.push(doc);
  }

  yield* Effect.try({
    catch: () => new GenerationError({ reason: "Invalid Lexicon graph" }),
    try: () => new Lexicons(structuredClone(docs)),
  });

  const manifest = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        devDependencies: Schema.Struct({ effect: Schema.String }),
      })
    )
  )(yield* fs.readFileString(path.join(root, "package.json")));

  const outputs = new Map<string, string>();

  for (const doc of docs) {
    outputs.set(
      `src/${filename(doc.id)}.ts`,
      yield* Effect.try({
        catch: (cause) =>
          Schema.is(GenerationError)(cause)
            ? cause
            : new GenerationError({ reason: "Unsupported schema graph" }),
        try: () => renderDocument(docs, doc),
      })
    );
  }

  for (const name of [
    "runtime",
    "query",
    "transport-failure",
    "xrpc-failure",
    "transport",
    "mailbox-client",
    "mailbox-handlers",
    "mailbox-server",
  ]) {
    outputs.set(
      `src/${name}.ts`,
      yield* fs.readFileString(
        path.join(root, `tools/lexgen/templates/${name}.ts.txt`)
      )
    );
  }

  outputs.set(
    "manifest.json",
    `${JSON.stringify({ effect: manifest.devDependencies.effect, generatorVersion: version, sourceDigest: digest.digest("hex"), sources: sources.map((source) => path.relative(root, source).split(path.sep).join("/")) }, null, 2)}\n`
  );
  const expected = new Set(outputs.keys());
  const destination = path.join(root, "packages/lexicon");
  const src = path.join(destination, "src");

  if (yield* fs.exists(src)) {
    for (const file of yield* walk(src)) {
      if (
        !expected.has(
          path.relative(destination, file).split(path.sep).join("/")
        )
      ) {
        return yield* new GenerationError({
          reason: "Unexpected generated file; remove explicitly after review",
        });
      }
    }
  }

  for (const [name, text] of outputs) {
    const formatted = yield* Effect.tryPromise({
      catch: () =>
        new GenerationError({ reason: `Formatting failed: ${name}` }),
      try: format.bind(undefined, name, text, formatConfig),
    });

    if (formatted.errors.length > 0) {
      return yield* new GenerationError({
        reason: `Invalid generated source: ${name}`,
      });
    }

    const target = path.join(destination, name);

    if (write) {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, formatted.code);
    } else if (
      !(yield* fs.exists(target)) ||
      (yield* fs.readFileString(target)) !== formatted.code
    ) {
      return yield* new GenerationError({
        reason: `Generation drift: packages/lexicon/${name}`,
      });
    }
  }

  return { documents: docs.length, files: outputs.size };
});
