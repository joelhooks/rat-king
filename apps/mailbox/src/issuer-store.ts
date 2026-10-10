import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Context, Layer, Schema } from "effect";
import type { Effect } from "effect";

import { Document } from "./auth.ts";
import type { Binding, PublicDocument } from "./issuer-policy.ts";
import type { Sql } from "./sqlite.ts";
import { storageOperation } from "./store.ts";

export interface IssuedName {
  readonly name: string;
  readonly did: string;
  readonly document: PublicDocument;
}

export interface IssuerTransaction {
  readonly enrolled: (host: string) => boolean;
  readonly enroll: (host: string) => void;
  readonly binding: (name: string) => Binding | undefined;
  readonly bind: (
    name: string,
    binding: Binding,
    document: PublicDocument
  ) => void;
  readonly names: (after: string, limit: number) => readonly IssuedName[];
}

export class IssuerStore extends Context.Service<
  IssuerStore,
  {
    readonly transaction: <A>(
      operation: (tx: IssuerTransaction) => A
    ) => Effect.Effect<A, XrpcFailure>;
  }
>()("mailbox/IssuerStore") {}

const BindingRow = Schema.Struct({
  did: Schema.String,
  fingerprint: Schema.String,
  host: Schema.String,
});

const NameRow = Schema.Struct({
  did: Schema.String,
  document: Schema.fromJsonString(Document),
  name: Schema.String,
});

export const issuerStore = (sql: Sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS hosts (did TEXT PRIMARY KEY)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, did TEXT NOT NULL UNIQUE, host TEXT NOT NULL, fingerprint TEXT NOT NULL, document TEXT NOT NULL)"
  );

  const transaction: IssuerTransaction = {
    bind: (name, binding, document) => {
      sql.exec(
        "INSERT INTO names (name,did,host,fingerprint,document) VALUES (?,?,?,?,?)",
        name,
        binding.did,
        binding.host,
        binding.fingerprint,
        JSON.stringify(document)
      );
    },
    binding: (name) => {
      const [row] = [
        ...sql.exec(
          "SELECT did,host,fingerprint FROM names WHERE name=?",
          name
        ),
      ];

      return row === undefined
        ? undefined
        : Schema.decodeUnknownSync(BindingRow)(row);
    },
    enroll: (host) => {
      sql.exec("INSERT OR IGNORE INTO hosts (did) VALUES (?)", host);
    },
    enrolled: (host) =>
      [...sql.exec("SELECT did FROM hosts WHERE did=?", host)].length > 0,
    names: (after, limit) =>
      Array.from(
        sql.exec(
          "SELECT name,did,document FROM names WHERE name > ? ORDER BY name ASC LIMIT ?",
          after,
          limit
        ),
        (row) => Schema.decodeUnknownSync(NameRow)(row)
      ),
  };

  return Layer.succeed(
    IssuerStore,
    IssuerStore.of({
      transaction: (operation) =>
        storageOperation(() => sql.transaction(() => operation(transaction))),
    })
  );
};
