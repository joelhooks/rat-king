/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, eslint/require-await, eslint/arrow-body-style -- The upstream async SQLite facade requires Promise callbacks, ordered queue tails and generic row delivery. */
// @effect-diagnostics newPromise:off -- Promise sequencing implements the upstream transaction queue, outside the Effect port.
// @effect-diagnostics asyncFunction:off -- This is pi-durable's asynchronous database interface.
import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import { Schema } from "effect";

export interface SqlHost {
  readonly sql: {
    readonly exec: (
      query: string,
      ...values: (string | number | null | ArrayBuffer)[]
    ) => Iterable<object>;
  };
  readonly transaction: <A>(operation: () => Promise<A>) => Promise<A>;
}

const binding = (value: SqliteValue): string | number | null | ArrayBuffer => {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value).buffer;
  }

  if (Schema.is(Schema.BigInt)(value)) {
    const number = Number(value);

    if (!Number.isSafeInteger(number)) {
      throw new RangeError(
        "SQLite integer exceeds the isolate's safe integer range"
      );
    }

    return number;
  }

  return value;
};

const executor = (host: SqlHost, active: () => boolean): SqliteExecutor => {
  const rows = (query: string, values: SqliteValue[]) => {
    if (!active()) {
      throw new Error("SQLite handle is closed");
    }

    return [...host.sql.exec(query, ...values.map(binding))];
  };

  return {
    all: async <T extends object>(query: string, ...values: SqliteValue[]) => {
      // SAFETY: SqliteExecutor's upstream generic promises caller-selected SQL row shapes. No domain decoding happens here.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The generic row representation is specified by the upstream facade, not knowable in this driver.
      return rows(query, values) as T[];
    },
    exec: async (query) => {
      rows(query, []);
    },
    get: async <T extends object>(query: string, ...values: SqliteValue[]) => {
      // SAFETY: Same upstream SQL row contract as all(); undefined represents no row.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Upstream callers own decoding of the selected SQL row shape.
      return rows(query, values)[0] as T | undefined;
    },
    run: async (query, ...values) => {
      rows(query, values);
    },
  };
};

export const durableSqlite = (host: SqlHost): SqliteDatabase => {
  let tail = Promise.resolve<null>(null);
  let closed = false;
  const direct = executor(host, () => !closed);

  const enqueue = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = tail.then(operation);
    tail = result.then(
      () => null,
      () => null
    );

    return result;
  };

  return {
    all: (query, ...values) => enqueue(() => direct.all(query, ...values)),
    close: () =>
      enqueue(async () => {
        closed = true;
      }),
    exec: (query) => enqueue(() => direct.exec(query)),
    get: (query, ...values) => enqueue(() => direct.get(query, ...values)),
    run: (query, ...values) => enqueue(() => direct.run(query, ...values)),
    transaction: (operation) =>
      enqueue(async () => {
        if (closed) {
          throw new Error("SQLite database is closed");
        }

        let active = true;

        try {
          return await host.transaction(() =>
            operation(executor(host, () => active))
          );
        } finally {
          active = false;
        }
      }),
  };
};
