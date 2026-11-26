import { Parent } from "@rat-king/lexicon/identity.listNames";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Context, Layer, Schema } from "effect";
import type { Effect } from "effect";

import { Document } from "./auth.ts";
import { failure } from "./failure.ts";
import type { DirectoryMode } from "./issuer-name-state.ts";
import {
  beginCompensation,
  claimDueTickets,
  directoryBootstrap,
  decodeProjection,
  finishTicket,
  observeName,
  projectionTables,
  seededProjection,
  stateColumns,
  writeTicket,
} from "./issuer-name-state.ts";
import { fingerprint } from "./issuer-policy.ts";
import type { Binding, PublicDocument } from "./issuer-policy.ts";
import { NameState } from "./name-state.ts";
import type {
  CompensationValue,
  NameStateValue,
  TicketValue,
} from "./name-state.ts";
import type { Sql } from "./sqlite.ts";
import { storageOperation } from "./store.ts";
import type { RetirementValue } from "./store.ts";

export interface IssuedName {
  readonly name: string;
  readonly did: string;
  readonly document: PublicDocument;
  readonly retired: boolean;
  readonly observation?: NameStateValue;
  readonly roleTarget: boolean;
  readonly parent?: typeof Parent.Type;
}

export interface RetiredName extends RetirementValue {
  readonly did: string;
  readonly observedAt?: number;
}

export interface RoleEntry {
  readonly name: string;
  readonly target: string;
  readonly role: string;
}

export interface IssuerTransaction {
  readonly spendScanReads: (
    caller: string,
    now: number,
    reads: number
  ) => boolean;
  readonly enrolled: (host: string) => boolean;
  readonly enroll: (host: string, document?: PublicDocument) => void;
  readonly authDocument: (did: string) => PublicDocument | undefined;
  readonly cacheAuthDocument: (document: PublicDocument) => void;
  readonly observation: (did: string) => NameStateValue | undefined;
  readonly observe: (state: NameStateValue) => number;
  readonly projectedRetirements: (
    after: string,
    limit: number
  ) => readonly RetiredName[];
  readonly writeTicket: (ticket: TicketValue, now: number) => boolean;
  readonly dueTickets: (now: number) => readonly TicketValue[];
  readonly directoryBootstrap: (mode: DirectoryMode) => boolean;
  readonly finishTicket: (ticket: TicketValue) => boolean;
  readonly beginCompensation: (
    ticket: TicketValue,
    compensation: CompensationValue
  ) => TicketValue | undefined;
  readonly binding: (name: string) => Binding | undefined;
  readonly bind: (
    name: string,
    binding: Binding,
    document: PublicDocument,
    parent?: typeof Parent.Type
  ) => void;
  readonly names: (
    after: string,
    limit: number,
    filter?: "active" | "retired" | "all",
    match?: string
  ) => readonly IssuedName[];
  readonly parentName: (did: string) => string | undefined;
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
  observation: Schema.NullOr(Schema.fromJsonString(NameState)),
  parent: Schema.NullOr(Schema.fromJsonString(Parent)),
  retired: Schema.Number,
  roleTarget: Schema.Number,
});

const ParentRow = Schema.Struct({ parent: Schema.fromJsonString(Parent) });

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
  updatedAt: Schema.NullOr(Schema.Int),
});

const projectRetired = ({
  successor,
  updatedAt,
  ...row
}: typeof RetiredRow.Type): RetiredName => {
  if (successor !== "") {
    Object.assign(row, { successor });
  }

  if (updatedAt !== null) {
    Object.assign(row, { updatedAt });
  }

  return row;
};

const scanReadLimit = 500;

const scanWindowMillis = 10 * 60 * 1000;

const ScanTotal = Schema.Struct({ reads: Schema.Int });

const TableColumn = Schema.Struct({ name: Schema.String });

export const issuerStore = (sql: Sql) => {
  projectionTables(sql);
  sql.exec("CREATE TABLE IF NOT EXISTS hosts (did TEXT PRIMARY KEY)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS issuer_documents (did TEXT PRIMARY KEY, document TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, did TEXT NOT NULL UNIQUE, host TEXT NOT NULL, fingerprint TEXT NOT NULL, document TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS name_parents (name TEXT PRIMARY KEY, parent TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS retired (name TEXT PRIMARY KEY, did TEXT NOT NULL, retired_at INTEGER NOT NULL, successor TEXT NOT NULL, by TEXT NOT NULL, updated_at INTEGER)"
  );
  sql.transaction(() => {
    const columns = Array.from(sql.exec("PRAGMA table_info(retired)"), (row) =>
      Schema.decodeUnknownSync(TableColumn)(row)
    );

    if (!columns.some(({ name }) => name === "updated_at")) {
      sql.exec("ALTER TABLE retired ADD COLUMN updated_at INTEGER");
    }
  });
  sql.exec(
    "CREATE TABLE IF NOT EXISTS roles (name TEXT PRIMARY KEY, target TEXT NOT NULL, role TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS scan_reads (caller TEXT NOT NULL, at INTEGER NOT NULL, reads INTEGER NOT NULL, PRIMARY KEY(caller, at))"
  );
  sql.exec("CREATE INDEX IF NOT EXISTS scan_reads_expiry ON scan_reads (at)");

  const transaction: IssuerTransaction = {
    authDocument: (did) => {
      const [row] = sql.exec(
        "SELECT document FROM names WHERE did=? UNION ALL SELECT document FROM issuer_documents WHERE did=? LIMIT 1",
        did,
        did
      );

      return row === undefined
        ? undefined
        : Schema.decodeUnknownSync(
            Schema.Struct({ document: NameRow.fields.document })
          )(row).document;
    },
    beginCompensation: (ticket, compensation) =>
      beginCompensation(sql, ticket, compensation),
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
    cacheAuthDocument: (document) => {
      const prior = transaction.authDocument(document.id);

      if (prior !== undefined && fingerprint(prior) !== fingerprint(document)) {
        throw failure("DocumentConflict", 409);
      }

      sql.exec(
        "INSERT OR IGNORE INTO issuer_documents (did,document) VALUES (?,?)",
        document.id,
        JSON.stringify(document)
      );
    },
    deleteRole: (name) =>
      [...sql.exec("DELETE FROM roles WHERE name=? RETURNING name", name)]
        .length > 0,
    directoryBootstrap: (mode) => directoryBootstrap(sql, mode),
    dueTickets: (now) => claimDueTickets(sql, now),
    enroll: (host, document) => {
      sql.exec("INSERT OR IGNORE INTO hosts (did) VALUES (?)", host);

      if (document !== undefined) {
        transaction.cacheAuthDocument(document);
      }
    },
    enrolled: (host) =>
      [...sql.exec("SELECT did FROM hosts WHERE did=?", host)].length > 0,
    finishTicket: (ticket) => finishTicket(sql, ticket),
    names: (after, limit, filter = "active", match = "") =>
      Array.from(
        sql.exec(
          "SELECT names.name,names.did,document,parent,EXISTS(SELECT 1 FROM retired WHERE retired.name=names.name) AS retired,EXISTS(SELECT 1 FROM roles WHERE roles.target=names.name) AS roleTarget,CASE WHEN seeded=1 THEN json_object('did',names.did,'version',version,'leaseExpiresAt',lease_expires_at,'leaseGeneration',lease_generation,'observedAt',observed_at,'retirement',json(retirement_json)) END AS observation FROM names LEFT JOIN name_parents ON names.name=name_parents.name LEFT JOIN name_state ON names.did=name_state.did WHERE names.name > ? AND (? = 'all' OR (? = 'retired') = EXISTS(SELECT 1 FROM retired WHERE retired.name=names.name)) AND (? = '' OR CASE WHEN substr(?, -1) = '/' THEN substr(lower(names.name), 1, length(?)) = lower(?) ELSE instr(lower(names.name), lower(?)) > 0 END) ORDER BY names.name ASC LIMIT ?",
          after,
          filter,
          filter,
          match,
          match,
          match,
          match,
          match,
          limit
        ),
        (row) => {
          const { observation, parent, retired, roleTarget, ...decoded } =
            Schema.decodeUnknownSync(NameRow)(row);

          const entry = {
            ...decoded,
            retired: retired === 1,
            roleTarget: roleTarget === 1,
          };

          if (observation !== null) {
            Object.assign(entry, { observation });
          }

          return parent === null ? entry : { ...entry, parent };
        }
      ),
    observation: (did) => {
      const [row] = sql.exec(
        `SELECT ${stateColumns} FROM name_state WHERE did=?`,
        did
      );

      return row === undefined
        ? undefined
        : seededProjection(decodeProjection(row));
    },
    observe: (state) => observeName(sql, state),
    parentName: (did) =>
      Array.from(
        sql.exec(
          "SELECT parent FROM name_parents JOIN names USING (name) WHERE names.did=?",
          did
        ),
        (row) => Schema.decodeUnknownSync(ParentRow)(row).parent.name
      ).at(0),
    projectedRetirements: (after, limit) =>
      Array.from(
        sql.exec(
          `SELECT ${stateColumns} FROM name_state WHERE seeded=1 AND retirement_json<>'null' AND json_extract(retirement_json,'$.name')>? ORDER BY json_extract(retirement_json,'$.name'),did LIMIT ?`,
          after,
          limit
        ),
        (row) => seededProjection(decodeProjection(row))
      ).flatMap((state) =>
        state === undefined || state.retirement === null
          ? []
          : [
              {
                ...state.retirement,
                did: state.did,
                observedAt: state.observedAt,
              },
            ]
      ),
    retire: (retired) => {
      sql.exec(
        "INSERT INTO retired (name,did,retired_at,successor,by,updated_at) VALUES (?,?,?,?,?,NULLIF(?,'')) ON CONFLICT(name) DO UPDATE SET did=excluded.did, retired_at=excluded.retired_at, successor=excluded.successor, by=excluded.by, updated_at=excluded.updated_at",
        retired.name,
        retired.did,
        retired.retiredAt,
        retired.successor ?? "",
        retired.by,
        retired.updatedAt ?? ""
      );
    },
    retired: (after, limit) =>
      Array.from(
        sql.exec(
          "SELECT name,did,retired_at AS retiredAt,successor,by,updated_at AS updatedAt FROM retired WHERE name > ? ORDER BY name ASC LIMIT ?",
          after,
          limit
        ),
        (row) => projectRetired(Schema.decodeUnknownSync(RetiredRow)(row))
      ),
    retiredEntry: (name) =>
      Array.from(
        sql.exec(
          "SELECT name,did,retired_at AS retiredAt,successor,by,updated_at AS updatedAt FROM retired WHERE name=?",
          name
        ),
        (row) => projectRetired(Schema.decodeUnknownSync(RetiredRow)(row))
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
    spendScanReads: (caller, now, reads) => {
      sql.exec("DELETE FROM scan_reads WHERE at <= ?", now - scanWindowMillis);

      const [total] = sql.exec(
        "SELECT COALESCE(SUM(reads),0) AS reads FROM scan_reads WHERE caller=?",
        caller
      );

      const spent = Schema.decodeUnknownSync(ScanTotal)(total).reads;

      if (spent + reads > scanReadLimit) {
        return false;
      }

      sql.exec(
        "INSERT INTO scan_reads (caller,at,reads) VALUES (?,?,?) ON CONFLICT(caller,at) DO UPDATE SET reads=scan_reads.reads+excluded.reads",
        caller,
        now,
        reads
      );

      return true;
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
    writeTicket: (ticket, now) => writeTicket(sql, ticket, now),
  };

  return Layer.succeed(
    IssuerStore,
    IssuerStore.of({
      transaction: (operation) =>
        storageOperation(() => sql.transaction(() => operation(transaction))),
    })
  );
};
