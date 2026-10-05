import { Data } from "effect";

const storePorts = [
  19_333, 18_081, 18_888, 18_333, 29_333, 28_081, 28_888, 28_333,
];

export type ListenerAssessment =
  | { readonly _tag: "Ready"; readonly receipt: string }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Violation"; readonly receipt: string };

const Assessment = Data.taggedEnum<ListenerAssessment>();

export const assessListeners = (
  text: string,
  publicIPv4: string,
  nodeExpected: boolean,
  sidecarExpected = false
): ListenerAssessment => {
  const sidecarPids = new Set(
    text
      .split("\n")
      .filter((line) => /:18789\s/u.test(line))
      .flatMap((line) =>
        [...line.matchAll(/pid=(?<pid>\d+)/gu)].map(
          (match) => match.groups?.pid
        )
      )
  );

  const lines = text
    .split("\n")
    .filter(
      (line) =>
        /users:\(\("(?:weed|celld)"/u.test(line) ||
        /rat-king/u.test(line) ||
        [...line.matchAll(/pid=(?<pid>\d+)/gu)].some((match) =>
          sidecarPids.has(match.groups?.pid)
        ) ||
        /:(?:19333|18081|18888|18333|29333|28081|28888|28333|18787|18788|18789)\s/u.test(
          line
        )
    );

  const expected = new Map(storePorts.map((port) => [port, "weed"]));

  if (nodeExpected) {
    expected.set(18_787, "celld");
    expected.set(18_788, "celld");
  }

  if (sidecarExpected) {
    expected.set(18_789, "node");
  }

  for (const line of lines) {
    const local = line.trim().split(/\s+/u)[3] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));

    const process = /users:\(\("(?<process>weed|celld|node)"/u.exec(line)
      ?.groups?.process;

    if (
      expected.get(port) !== process ||
      local !== `${port === 18_787 ? publicIPv4 : "127.0.0.1"}:${port}` ||
      !expected.delete(port)
    ) {
      return Assessment.Violation({ receipt: lines.join("\n") });
    }
  }

  return expected.size === 0
    ? Assessment.Ready({ receipt: lines.join("\n") })
    : Assessment.Waiting();
};
