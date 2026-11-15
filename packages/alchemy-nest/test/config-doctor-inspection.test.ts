import { it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  decodeInspection,
  doctorStderr,
  inspectionDeadline,
  retryDoctorInspection,
} from "../../../stacks/nest/config-doctor-inspection.ts";

it.effect.prop(
  "inspection separates transport, node, decoded faults and invalid results",
  [Schema.Int.check(Schema.isBetween({ maximum: 254, minimum: 1 }))],
  ([code]) =>
    Effect.gen(function* mapping() {
      for (const remote of [false, true]) {
        const node = yield* decodeInspection(
          "secondary",
          remote,
          "",
          code,
          "node error"
        );

        expect(node.status).toBe("fail");
        expect(node.reasons[0]).toContain(`node failed (exit ${code})`);
      }

      const ssh = yield* decodeInspection(
        "secondary",
        true,
        "",
        255,
        "ssh error"
      );

      expect(ssh.status).toBe("warn");
      expect(ssh.reasons[0]).toContain(
        "ssh connect or transport failed (exit 255)"
      );
      expect(
        (yield* decodeInspection("primary", false, "", 255, "node error"))
          .status
      ).toBe("fail");

      for (const status of ["ok", "fail"] as const) {
        expect(
          yield* decodeInspection(
            "secondary",
            true,
            JSON.stringify({ reasons: ["identity check"], status }),
            0,
            ""
          )
        ).toEqual({ reasons: ["secondary: identity check"], status });
      }

      expect(
        (yield* decodeInspection("secondary", true, "not json", 0, "")).status
      ).toBe("warn");
    })
);

it.effect.prop(
  "only pre-session mux errors with empty stdout retry once, on a solo connection",
  [Schema.Boolean, Schema.Boolean],
  ([remote, output]) =>
    Effect.gen(function* retry() {
      for (const stderr of [
        "mm_send_fd: sendmsg(0): Message too long",
        "mm_receive_fd failed",
        "Control socket connect failed",
        "session request failed",
        "read header failed",
        "read from master failed",
        "mm_send_fd: read header failed",
        "connection refused",
      ]) {
        const calls: boolean[] = [];
        yield* retryDoctorInspection(remote, (solo) =>
          Effect.sync(() => {
            calls.push(solo);

            return { code: 255, output: output ? "remote ran" : "", stderr };
          })
        );

        const safe =
          /^(?:mm_send_fd: sendmsg|mm_receive_fd|Control socket|session request)/u.test(
            stderr
          );

        expect(calls).toEqual(
          remote && !output && safe ? [false, true] : [false]
        );
      }

      const calls: boolean[] = [];
      yield* retryDoctorInspection(true, (solo) =>
        Effect.sync(() => {
          calls.push(solo);

          return { code: 1, output: "", stderr: "mm_send_fd" };
        })
      );
      expect(calls).toEqual([false]);
    })
);

it.prop(
  "stderr tails redact before bounding UTF-8 bytes",
  [Schema.String],
  ([prefix]) => {
    const tail = doctorStderr(
      `${prefix}\npassword=secret-value\nBearer secret-value\n${"界".repeat(120)}`
    );

    expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(300);
    expect(tail).not.toContain("secret-value");
    expect(doctorStderr("password=secret-value")).not.toContain("secret-value");
  }
);

it.effect(
  "inspection timeout is unavailable, distinct from a process startup failure",
  () =>
    Effect.gen(function* timeout() {
      const fiber = yield* inspectionDeadline(
        "secondary",
        Effect.never,
        () => "password=secret-value"
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({
        reasons: [
          "secondary: Pi configuration inspection timed out after 30 seconds: password=<redacted>",
        ],
        status: "warn",
      });

      const startup = yield* inspectionDeadline(
        "secondary",
        Effect.fail("spawn failed")
      );

      expect(startup.status).toBe("warn");
      expect(startup.reasons[0]).toContain("process could not start");
    })
);
