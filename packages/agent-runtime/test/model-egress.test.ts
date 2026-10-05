/* oxlint-disable typescript/promise-function-async -- Injected fetch and Promise rejection test. */
// @effect-diagnostics asyncFunction:off -- Test exercises the fetch adapter's Promise contract.
import { expect, it } from "vitest";

import { EgressRefused, originFetch } from "../src/model-egress.ts";

it("model egress permits only its origin and refuses automatic redirects", async () => {
  const calls: RequestInit[] = [];

  const outbound: typeof fetch = (_input, init) => {
    calls.push(init ?? {});

    return Promise.resolve(new Response("ok"));
  };

  const guarded = originFetch("https://models.example.invalid/v1", outbound);

  const response = await guarded(
    "https://models.example.invalid/v1/chat/completions"
  );

  expect(await response.text()).toBe("ok");
  expect(calls).toEqual([{ redirect: "error" }]);

  await expect(
    guarded("https://other.example.invalid/v1")
  ).rejects.toBeInstanceOf(EgressRefused);
  await expect(
    guarded("https://models.example.invalid:444/v1")
  ).rejects.toBeInstanceOf(EgressRefused);
  const userinfo = new URL("https://models.example.invalid/v1");
  userinfo.username = "example-key";

  await expect(guarded(userinfo)).rejects.toBeInstanceOf(EgressRefused);
  expect(calls).toHaveLength(1);
});
