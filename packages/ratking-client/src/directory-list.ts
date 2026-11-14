import type { RetiredNamesValue } from "./directory.ts";

export const projectLocalNames = <A extends { readonly name: string }>(
  entries: readonly A[],
  retired: RetiredNamesValue,
  filter: "active" | "retired" | "all"
) =>
  entries.flatMap((entry) => {
    const hidden = Object.hasOwn(retired, entry.name);

    if ((filter === "active" && hidden) || (filter === "retired" && !hidden)) {
      return [];
    }

    return [hidden ? { ...entry, status: "retired" as const } : entry];
  });
