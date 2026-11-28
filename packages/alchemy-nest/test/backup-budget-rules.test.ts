import { it } from "@effect/vitest";
import { Duration, Schema } from "effect";
import { expect } from "vitest";

import {
  backupCover,
  BACKUP_STOP_BUDGET_MS,
  coversOf,
  MAILBOX_INSTANCE,
} from "../../../stacks/nest/alarm-maintenance.ts";
import {
  precopyAlarmSeconds,
  precopyLimit,
  precopyRequestedMinutes,
} from "../../../stacks/nest/backup-limits.ts";
import { backupTimer, backupUnit } from "../../../stacks/nest/backup-units.ts";
import { packLimit, transferLimit } from "../../../stacks/nest/backup.ts";
import { epoch, gib, integer, positive } from "./nest-rule-generators.ts";

const mib = 1024 ** 2;

it.prop(
  "precopy adds a minute at the first byte of each chargeable GiB below the ceiling",
  [integer(100, 164)],
  ([whole]) => {
    const before = Duration.toMinutes(precopyLimit(whole * gib));
    expect(Duration.toMinutes(precopyLimit(whole * gib + 1))).toBe(before + 1);
  }
);

it.prop(
  "the requested precopy allowance keeps reporting capacity demand beyond the enforced cap",
  [integer(166, 2000)],
  ([whole]) => {
    expect(precopyRequestedMinutes(whole * gib)).toBeGreaterThan(90);
    expect(precopyRequestedMinutes((whole + 1) * gib)).toBe(
      precopyRequestedMinutes(whole * gib) + 1
    );
  }
);

it.prop(
  "the in-process precopy alarm reserves ten seconds even for fractional limits",
  [integer(10_000, 5_400_000)],
  ([ms]) => {
    expect(precopyAlarmSeconds(Duration.millis(ms)) * 1000).toBeCloseTo(
      ms - 10_000,
      5
    );
  }
);

it.prop(
  "pack charges only for started GiB beyond the minimum allowance",
  [integer(40, 1200), integer(2, gib)],
  ([whole, offset]) => {
    const boundary = Duration.toMinutes(packLimit(whole * gib));
    expect(Duration.toMinutes(packLimit(whole * gib + 1))).toBe(boundary + 1);
    expect(Duration.toMinutes(packLimit(whole * gib + offset))).toBe(
      boundary + 1
    );
  }
);

it.prop(
  "transfer grants one second per started MiB, without charging an exact MiB twice",
  [integer(0, 30_000), integer(2, mib)],
  ([whole, offset]) => {
    const boundary = Duration.toSeconds(transferLimit(whole * mib));
    expect(Duration.toSeconds(transferLimit(whole * mib + 1))).toBe(
      boundary + 1
    );
    expect(Duration.toSeconds(transferLimit(whole * mib + offset))).toBe(
      boundary + 1
    );
  }
);

it.prop(
  "a completed backup cannot borrow unused stop budget after it ends",
  [epoch, integer(0, BACKUP_STOP_BUDGET_MS - 1)],
  ([start, elapsed]) => {
    const end = start + elapsed;
    expect(backupCover({ end, start })).toMatchObject({
      end,
      until: start + BACKUP_STOP_BUDGET_MS,
    });
  }
);

it.prop(
  "a missing end and an overlong backup both reach the same hard stop deadline",
  [epoch, positive],
  ([start, overrun]) => {
    const deadline = start + BACKUP_STOP_BUDGET_MS;
    expect(backupCover({ end: null, start })).toMatchObject({ end: deadline });
    expect(backupCover({ end: deadline + overrun, start })).toMatchObject({
      end: deadline,
    });
  }
);

it.prop(
  "the backup stop budget never grants a maintenance exemption to a sibling instance",
  [epoch, positive],
  ([start, id]) => {
    const facts = { backup: { end: null, start } };
    expect(coversOf(facts, `instance-${id}`)).toEqual([]);
    expect(coversOf(facts, MAILBOX_INSTANCE)).toMatchObject([
      { recipients: [], start },
    ]);
  }
);

const argument = Schema.Literals([
  "home",
  "dataRoot",
  "backupRoot",
  "version",
  "commit",
]);

const unitSeed = {
  backupRoot: "/mnt/example",
  commit: "example-sha",
  dataRoot: "/srv/example",
  home: "/home/example",
  ready: "ready-example",
  version: "example-version",
};

const execStart = (input: Parameters<typeof backupUnit>[0]) =>
  backupUnit(input)
    .sections?.flatMap((section) => section.lines)
    .find(([key]) => key === "ExecStart")?.[1];

it.prop(
  "systemd receives escaped percent specifiers in backup arguments",
  [argument, positive],
  ([key, id]) => {
    expect(execStart({ ...unitSeed, [key]: `x-${id}%n` })).toContain(
      `"x-${id}%%n"`
    );
  }
);

it.prop(
  "systemd keeps embedded quotes and backslashes inside one backup argument",
  [argument, positive],
  ([key, id]) => {
    expect(execStart({ ...unitSeed, [key]: `x-${id} " \\ y` })).toContain(
      `"x-${id} \\" \\\\ y"`
    );
  }
);

it.prop(
  "the optional health endpoint is appended as one argument without changing earlier arguments",
  [positive],
  ([id]) => {
    const base = execStart(unitSeed);
    expect(base).toBeDefined();
    const endpoint = `https://example.invalid/health/${id}`;
    expect(execStart({ ...unitSeed, healthUrl: endpoint })).toBe(
      `${base} "${endpoint}"`
    );
  }
);

it.prop(
  "the nightly timer targets the matching backup service in the same user scope",
  [positive],
  ([id]) => {
    const home = `/home/example-${id}`;
    const ready = `ready-${id}`;
    const timer = backupTimer(home, ready);
    const service = backupUnit({ ...unitSeed, home, ready });
    expect(
      timer.sections?.find((section) => section.name === "Timer")?.lines
    ).toContainEqual(["Unit", service.name]);
    expect(timer).toMatchObject({ home, restartOn: [ready], scope: "user" });
    expect(service).toMatchObject({
      enabled: false,
      home,
      restartOn: [ready],
      scope: "user",
      started: false,
    });
  }
);
