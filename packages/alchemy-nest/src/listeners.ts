import { Data, Effect } from "effect";

import { must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { declaredListeners, listenerUnits } from "./listener-contract.ts";

export type ListenerAssessment =
  | { readonly _tag: "Ready"; readonly receipt: string }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Violation"; readonly receipt: string };

const Assessment = Data.taggedEnum<ListenerAssessment>();

export const assessListeners = (
  text: string,
  publicIPv4: string,
  nodeExpected: boolean,
  sidecarExpected = false,
  unitCgroups: ReadonlyMap<string, string> = new Map()
): ListenerAssessment => {
  const expected = declaredListeners(publicIPv4, nodeExpected, sidecarExpected);

  const reservedPorts = new Set(
    declaredListeners(publicIPv4, true, true).map(({ port }) => port)
  );

  const remaining = new Set(
    expected.map(({ unit, address, port }) => `${unit}|${address}|${port}`)
  );

  const lines: string[] = [];

  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("State")) {
      continue;
    }

    const local = line.trim().split(/\s+/u)[3] ?? "";
    const separator = local.lastIndexOf(":");
    const address = local.slice(0, separator).replaceAll(/^\[|\]$/gu, "");
    const port = Number(local.slice(separator + 1));
    const cgroup = /(?:^|\s)cgroup:(?<path>\/\S+)/u.exec(line)?.groups?.path;

    const unit = listenerUnits.find(
      (name) => unitCgroups.get(name) === cgroup && cgroup !== undefined
    );

    const stackCgroup =
      cgroup
        ?.split("/")
        .some(
          (part) => part === "rat-king.slice" || part.startsWith("rat-king-")
        ) === true;

    if (unit === undefined && !stackCgroup && !reservedPorts.has(port)) {
      continue;
    }

    lines.push(line);

    if (unit === undefined || !remaining.delete(`${unit}|${address}|${port}`)) {
      return Assessment.Violation({ receipt: lines.join("\n") });
    }
  }

  return remaining.size === 0
    ? Assessment.Ready({ receipt: lines.join("\n") })
    : Assessment.Waiting();
};

export const readListeners = Effect.fn("Listeners.read")(function* read(
  shell: Pick<Interface, "exec">
) {
  const unitCgroups = new Map<string, string>();

  for (const unit of listenerUnits) {
    const result = yield* shell.exec([
      "systemctl",
      "--user",
      "show",
      unit,
      "--property=ControlGroup",
      "--value",
    ]);

    const cgroup = result.stdout.trim();

    if (
      result.code === 0 &&
      /^\/\S+$/u.test(cgroup) &&
      cgroup.endsWith(`/${unit}`)
    ) {
      unitCgroups.set(unit, cgroup);
    }
  }

  const text = yield* must(shell, ["ss", "-H", "-ltnp", "--cgroup"]);

  return { text, unitCgroups };
});
