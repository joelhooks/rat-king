import { Data } from "effect";

export class AlarmRefused extends Data.TaggedError("AlarmRefused")<{
  readonly code: "Retired" | "UnknownName";
  readonly successor?: string;
}> {}

const successorOf = (reason: string) =>
  /current row is (?<successor>\S+)$/u.exec(reason)?.groups?.successor;

export const terminalRefusal = (error: {
  readonly error?: string;
  readonly reason: string;
  readonly status?: number;
}) => {
  if (error.error === "Retired" || error.status === 410) {
    const successor = successorOf(error.reason);

    return new AlarmRefused(
      successor === undefined
        ? { code: "Retired" }
        : { code: "Retired", successor }
    );
  }

  return error.error === "UnknownName"
    ? new AlarmRefused({ code: "UnknownName" })
    : undefined;
};
