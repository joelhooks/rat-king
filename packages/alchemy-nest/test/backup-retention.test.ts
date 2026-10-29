import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupRetentionScript } from "../src/backup-retention-script.ts";
import { localExec } from "../src/local-exec.ts";

const plannerFixture = String.raw`
import datetime, json, random, sys
exec(sys.argv[1])
days = json.loads(sys.argv[2])
start = datetime.date(2025, 12, 15)
names = sorted(set((start + datetime.timedelta(days=day)).strftime('%Y%m%dT100000.000000Z-') + 'a'*32 for day in days))
# Independent selection predicate: seven later names, four later distinct ISO weeks.
weeks = {name: datetime.date(int(name[:4]), int(name[4:6]), int(name[6:8])).isocalendar()[:2] for name in names}
expected = {name for index, name in enumerate(names) if index == 0 or len(names) - index <= 7 or (not any(other > name and weeks[other] == weeks[name] for other in names) and len({weeks[other] for other in names if weeks[other] > weeks[name]}) < 4)}
random.Random(42).shuffle(names)
assert retention_keep(names) == expected, (names, retention_keep(names), expected)
assert retention_keep(sorted(expected)) == expected
print('RETENTION_PLANNER_PASSED')
`;

it.effect.prop(
  "the keep set preserves seven recent names, four ISO weeks and the first across missing dates and December/January",
  {
    days: Arbitrary.schema(
      Schema.Array(
        Schema.Int.check(Schema.isBetween({ maximum: 400, minimum: 0 }))
      ).check(Schema.isMaxLength(80))
    ),
  },
  ({ days }) =>
    Effect.gen(function* plannerContract() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        plannerFixture,
        backupRetentionScript,
        JSON.stringify(days),
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("RETENTION_PLANNER_PASSED");
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 100 } }
);
