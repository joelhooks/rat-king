// @effect-diagnostics nodeBuiltinImport:off -- Read-only receipts from the test-owned workerd SQLite files.
import { DatabaseSync } from "node:sqlite";

import { Effect, FileSystem, Schema } from "effect";

const ActorId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const namespaces = (directory: string, namespace: string) =>
  Effect.gen(function* findNamespace() {
    const fs = yield* FileSystem.FileSystem;
    const local = `${directory}/local`;
    const entries = yield* fs.readDirectory(local);
    const suffix = `-${namespace}`;
    const name = entries.find((entry) => entry.endsWith(suffix));

    if (name === undefined) {
      return yield* Effect.die(`Missing ${namespace} SQLite namespace`);
    }

    return `${local}/${name}`;
  });

export const objectDatabaseExists = (directory: string, namespace: string) =>
  Effect.gen(function* hasObjectDb() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* namespaces(directory, namespace);
    const files = yield* fs.readDirectory(path);

    return files.some((entry) => /^[0-9a-f]{64}\.sqlite$/u.test(entry));
  });

export const taskAlarmPersisted = (directory: string, at: number) =>
  Effect.gen(function* hasAlarm() {
    const path = yield* namespaces(directory, "Board.TaskAggregate");

    return yield* Effect.sync(() => {
      using metadata = new DatabaseSync(`${path}/metadata.sqlite`, {
        readOnly: true,
      });

      const row = metadata
        .prepare("SELECT actor_id FROM _cf_ALARM LIMIT 1")
        .get();

      const actorId = row?.actor_id;

      if (!Schema.is(ActorId)(actorId)) {
        return false;
      }

      using storage = new DatabaseSync(`${path}/${actorId}.sqlite`, {
        readOnly: true,
      });

      return (
        storage
          .prepare(
            "SELECT 1 FROM alchemy_alarm_callbacks WHERE id = ? AND run_at = ?"
          )
          .get("claim-expiry", at) !== undefined
      );
    });
  });
