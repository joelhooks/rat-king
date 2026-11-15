import { Effect, Schema } from "effect";

import { redactStderrExcerpt } from "./ship-diagnostics.ts";

export const DoctorResult = Schema.Struct({
  reasons: Schema.Array(Schema.String),
  status: Schema.Literals(["ok", "fail"]),
});

export const doctorMuxFailure = (
  code: number,
  stderr: string,
  stdout: string
) =>
  code === 255 &&
  stdout === "" &&
  !/read header failed|read from master failed/iu.test(stderr) &&
  /\bmm_send_fd\b|\bmm_receive_fd\b|Control ?socket connect|session request failed/iu.test(
    stderr
  );

export const retryDoctorInspection = <E, R>(
  remote: boolean,
  attempt: (solo: boolean) => Effect.Effect<
    {
      readonly code: number;
      readonly output: string;
      readonly stderr: string;
    },
    E,
    R
  >
) =>
  attempt(false).pipe(
    Effect.flatMap((result) =>
      remote && doctorMuxFailure(result.code, result.stderr, result.output)
        ? attempt(true)
        : Effect.succeed(result)
    )
  );

export const doctorStderr = (stderr: string) => {
  const chars = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(redactStderrExcerpt(stderr));

  let tail = "";

  for (const { segment: char } of [...chars].toReversed()) {
    if (new TextEncoder().encode(char + tail).length > 300) {
      break;
    }

    tail = char + tail;
  }

  return tail;
};

export const inspectionUnavailable = (label: string, step: string) => ({
  reasons: [`${label}: Pi configuration inspection ${step}`],
  status: "warn" as const,
});

export const inspectionDeadline = <E, R>(
  label: string,
  effect: Effect.Effect<
    {
      readonly reasons: readonly string[];
      readonly status: "ok" | "warn" | "fail";
    },
    E,
    R
  >,
  stderr: () => string = () => ""
) =>
  effect.pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.succeed(
        inspectionUnavailable(
          label,
          `timed out after 30 seconds${doctorStderr(stderr()) === "" ? "" : `: ${doctorStderr(stderr())}`}`
        )
      )
    ),
    Effect.orElseSucceed(() =>
      inspectionUnavailable(label, "process could not start")
    )
  );

export const decodeInspection = Effect.fn("Nest.decodeInspection")(
  function* decodeInspection(
    label: string,
    remote: boolean,
    output: string,
    code: number,
    stderr: string
  ) {
    if (code !== 0) {
      const transport = remote && code === 255;

      const step = transport
        ? "ssh connect or transport failed"
        : "node failed";

      const tail = doctorStderr(stderr);

      return {
        reasons: [
          `${label}: ${step} (exit ${code})${tail === "" ? "" : `: ${tail}`}`,
        ],
        status: transport ? ("warn" as const) : ("fail" as const),
      };
    }

    const facts = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(DoctorResult)
    )(output).pipe(
      Effect.map((result) => ({
        reasons: result.reasons.map((reason) => `${label}: ${reason}`),
        status: result.status,
      })),
      Effect.orElseSucceed(() =>
        inspectionUnavailable(label, "result could not be decoded")
      )
    );

    return facts;
  }
);
