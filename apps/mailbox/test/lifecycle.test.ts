import { expect, it } from "vitest";

import { advance } from "../src/lifecycle.ts";

it("delivery separates admission, queue, injection and processing; terminal states cannot revive", () => {
  expect(advance("accepted", "queue")).toBe("queued");
  expect(advance("queued", "inject")).toBe("delivered");
  expect(advance("delivered", "inject")).toBe("delivered");
  expect(advance("delivered", "ack")).toBe("acked");
  expect(advance("accepted", "ack")).toBe("accepted");

  for (const state of ["accepted", "queued", "delivered"] as const) {
    expect(advance(state, "expire")).toBe("expired");
    expect(advance(state, "fail")).toBe("failed");
  }

  for (const state of ["acked", "expired", "failed"] as const) {
    for (const command of [
      "queue",
      "inject",
      "ack",
      "expire",
      "fail",
    ] as const) {
      expect(advance(state, command)).toBe(state);
    }
  }
});
