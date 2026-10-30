import type { InstanceLayout } from "./instance.ts";

export interface ListenerRow {
  readonly line: string;
  readonly address: string;
  readonly port: number;
  readonly unit: string | undefined;
}

const holder = (line: string) => {
  const found = /users:\(\("(?<name>[^"]+)",pid=(?<pid>\d+)/u.exec(
    line
  )?.groups;

  return found === undefined
    ? "an unknown process"
    : `${found.name ?? "?"} (pid ${found.pid ?? "?"})`;
};

export const foreignWording = (row: ListenerRow) =>
  `port ${row.port} held by ${holder(row.line)}, not a Rat King unit`;

const seenWording = (row: ListenerRow) =>
  `${row.address}:${row.port} ${holder(row.line)}`;

export const foreignRows = (
  rows: readonly ListenerRow[],
  inStack: (part: string) => boolean
) =>
  rows.filter(
    ({ line, unit }) =>
      unit === undefined &&
      !(
        /(?:^|\s)cgroup:(?<path>\/\S+)/u
          .exec(line)
          ?.groups?.path?.split("/")
          .some(inStack) ?? false
      )
  );

export const unique = (rows: readonly string[]) => [...new Set(rows)];

export const foreignReport = (
  rows: readonly ListenerRow[],
  inStack: (part: string) => boolean
) => unique(foreignRows(rows, inStack).map(foreignWording));

export const mismatchReport = (
  rows: readonly ListenerRow[],
  inStack: (part: string) => boolean
) =>
  [
    ...foreignReport(rows, inStack),
    `listeners seen: ${unique(rows.map(seenWording)).join(", ")}`,
  ].join("; ");

export const inStack = (part: string) =>
  part === "rat-king.slice" || part.startsWith("rat-king-");

export const inLayoutStack = (layout: InstanceLayout) => (part: string) =>
  part === layout.slice ||
  part === layout.storeUnit ||
  part === layout.nodeUnit;
