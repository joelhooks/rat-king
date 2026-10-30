import { Parent } from "@rat-king/lexicon/identity.listNames";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Context, Layer, Schema } from "effect";
import type { Effect } from "effect";

import { Document } from "./auth.ts";
import type { Binding, PublicDocument } from "./issuer-policy.ts";
import type { Sql } from "./sqlite.ts";
import { storageOperation } from "./store.ts";
import type { RetirementValue } from "./store.ts";

export interface IssuedName {
  readonly name: string;
  readonly did: string;
  readonly document: PublicDocument;
  readonly parent?: typeof Parent.Type;
}

export interface RetiredName extends RetirementValue {
  readonly did: string;
}

export interface RoleEntry {
  readonly name: string;
  readonly target: string;
  readonly role: string;
}

export interface IssuerTransaction {
  readonly enrolled: (host: string) => boolean;
  readonly enroll: (host: string) => void;
  readonly binding: (name: string) => Binding | undefined;
  readonly bind: (
    name: string,
    binding: Binding,
    document: PublicDocument,
    parent?: typeof Parent.Type
  ) => void;
  readonly names: (after: string, limit: number) => readonly IssuedName[];
  readonly retire: (retired: RetiredName) => void;
  readonly unretire: (name: string, retiredAt?: number) => void;
  readonly retired: (after: string, limit: number) => readonly RetiredName[];
  readonly retiredEntry: (name: string) => RetiredName | undefined;
  readonly role: (name: string) => RoleEntry | undefined;
  readonly setRole: (entry: RoleEntry) => void;
  readonly deleteRole: (name: string) => boolean;
  readonly roles: (after: string, limit: number) => readonly RoleEntry[];
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
  parent: Schema.NullOr(Schema.fromJsonString(Parent)),
});

const RoleRow = Schema.Struct({
  name: Schema.String,
  role: Schema.String,
  target: Schema.String,
});

const RetiredRow = Schema.Struct({
  by: Schema.String,
  did: Schema.String,
  name: Schema.String,
  retiredAt: Schema.Int,
  successor: Schema.String,
});

export const issuerStore = (sql: Sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS hosts (did TEXT PRIMARY KEY)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, did TEXT NOT NULL UNIQUE, host TEXT NOT NULL, fingerprint TEXT NOT NULL, document TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS name_parents (name TEXT PRIMARY KEY, parent TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS retired (name TEXT PRIMARY KEY, did TEXT NOT NULL, retired_at INTEGER NOT NULL, successor TEXT NOT NULL, by TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS roles (name TEXT PRIMARY KEY, target TEXT NOT NULL, role TEXT NOT NULL)"
  );

  const transaction: IssuerTransaction = {
    bind: (name, binding, document, parent) => {
      sql.exec(
        "INSERT INTO names (name,did,host,fingerprint,document) VALUES (?,?,?,?,?)",
        name,
        binding.did,
        binding.host,
        binding.fingerprint,
        JSON.stringify(document)
      );

      if (parent !== undefined) {
        sql.exec(
          "INSERT INTO name_parents (name,parent) VALUES (?,?)",
          name,
          JSON.stringify(parent)
        );
      }
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
    deleteRole: (name) =>
      [...sql.exec("DELETE FROM roles WHERE name=? RETURNING name", name)]
        .length > 0,
    enroll: (host) => {
      sql.exec("INSERT OR IGNORE INTO hosts (did) VALUES (?)", host);
    },
    enrolled: (host) =>
      [...sql.exec("SELECT did FROM hosts WHERE did=?", host)].length > 0,
    names: (after, limit) =>
      Array.from(
        sql.exec(
          "SELECT names.name,did,document,parent FROM names LEFT JOIN name_parents ON names.name=name_parents.name WHERE names.name > ? ORDER BY names.name ASC LIMIT ?",
          after,
          limit
        ),
        (row) => {
          const { parent, ...entry } = Schema.decodeUnknownSync(NameRow)(row);

          return parent === null ? entry : { ...entry, parent };
        }
      ),
    retire: (retired) => {
      sql.exec(
        "INSERT INTO retired (name,did,retired_at,successor,by) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET did=excluded.did, retired_at=excluded.retired_at, successor=excluded.successor, by=excluded.by",
        retired.name,
        retired.did,
        retired.retiredAt,
        retired.successor ?? "",
        retired.by
      );
    },
    retired: (after, limit) =>
      Array.from(
        sql.exec(
          "SELECT name,did,retired_at AS retiredAt,successor,by FROM retired WHERE name > ? ORDER BY name ASC LIMIT ?",
          after,
          limit
        ),
        (row) => {
          const { successor, ...decoded } =
            Schema.decodeUnknownSync(RetiredRow)(row);

          return successor === "" ? decoded : { ...decoded, successor };
        }
      ),
    retiredEntry: (name) =>
      Array.from(
        sql.exec(
          "SELECT name,did,retired_at AS retiredAt,successor,by FROM retired WHERE name=?",
          name
        ),
        (row) => {
          const { successor, ...decoded } =
            Schema.decodeUnknownSync(RetiredRow)(row);

          return successor === "" ? decoded : { ...decoded, successor };
        }
      ).at(0),
    role: (name) =>
      Array.from(
        sql.exec("SELECT name,target,role FROM roles WHERE name=?", name),
        (row) => Schema.decodeUnknownSync(RoleRow)(row)
      ).at(0),
    roles: (after, limit) =>
      Array.from(
        sql.exec(
          "SELECT name,target,role FROM roles WHERE name > ? ORDER BY name ASC LIMIT ?",
          after,
          limit
        ),
        (row) => Schema.decodeUnknownSync(RoleRow)(row)
      ),
    setRole: (entry) => {
      sql.exec(
        "INSERT INTO roles (name,target,role) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET target=excluded.target, role=excluded.role",
        entry.name,
        entry.target,
        entry.role
      );
    },
    unretire: (name, retiredAt) => {
      if (retiredAt === undefined) {
        sql.exec("DELETE FROM retired WHERE name=?", name);
      } else {
        sql.exec(
          "DELETE FROM retired WHERE name=? AND retired_at=?",
          name,
          retiredAt
        );
      }
    },
  };

  return Layer.succeed(
    IssuerStore,
    IssuerStore.of({
      transaction: (operation) =>
        storageOperation(() => sql.transaction(() => operation(transaction))),
    })
  );
};
