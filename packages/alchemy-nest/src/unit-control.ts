import { Effect } from "effect";

import { refuse } from "./files.ts";
import type { Interface } from "./host-shell.ts";
import type { UnitProps } from "./systemd.ts";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const resources =
  /^(?:CPU|Memory|Tasks|IO|IP|Device|Allowed|Startup(?:CPU|IO|Allowed))[A-Za-z0-9]*$/u;

export const assertDeclaredControlDropIns = Effect.fn(
  "SystemdUnit.controlDropIns"
)(function* assertDeclaredControlDropIns(
  shell: Interface,
  props: UnitProps,
  paths: readonly string[]
) {
  const declared = new Set(
    props.sections
      .filter(
        (section) => section.name === "Service" || section.name === "Slice"
      )
      .flatMap((section) =>
        section.lines
          .filter(([key]) => resources.test(key))
          .map(([key]) => `${section.name}.${key}`)
      )
  );

  if (declared.size === 0) {
    return yield* Effect.void;
  }

  for (const path of paths.filter((entry) =>
    entry.includes("/systemd/user.control/")
  )) {
    const bytes = yield* shell.read(path);

    if (bytes === undefined) {
      return yield* refuse(
        `Cannot inspect control drop-in ${quote(path)}; declared resource limits cannot be proved. Review systemctl --user cat ${quote(props.name)}, then reload the manager and re-run the plan.`
      );
    }

    let section = "";

    for (const raw of new TextDecoder().decode(bytes).split("\n")) {
      const line = raw.trim();
      const heading = /^\[(?<section>[A-Za-z][A-Za-z0-9]*)\]$/u.exec(line);

      if (heading !== null) {
        section = heading.groups?.section ?? "";
        continue;
      }

      const key = /^(?<key>[A-Za-z][A-Za-z0-9]*)\s*=/u.exec(line)?.groups?.key;

      if (key !== undefined && declared.has(`${section}.${key}`)) {
        return yield* refuse(
          `Control drop-in ${quote(path)} overrides declared ${key}; deployment could use the wrong resource limit even when its current value matches. Review systemctl --user cat ${quote(props.name)}. Check the underlying unit limits before disabling the file; reload can lower a live limit. After reviewing the file, disable it with mv -n -- ${quote(path)} ${quote(`${path}.disabled`)}; then run systemctl --user daemon-reload and re-run the plan. Reload alone does not restart services. Review any newly revealed control drop-ins before applying.`
        );
      }
    }
  }

  return yield* Effect.void;
});
