import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import { gatewayUrl } from "../src/gateway-url.ts";

const UrlParts = Schema.Struct({
  loopback: Schema.Literals([
    "127.0.0.0",
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.255",
    "[::1]",
  ]),
  path: Schema.Literals(["", "/proxy", "/proxy/path"]),
  port: Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 })),
  remote: Schema.Literals([
    "gateway.example.invalid",
    "loopback.example.invalid",
    "127.0.0.1.example.invalid",
    "192.0.2.1",
    "[2001:db8::1]",
    "[::ffff:192.0.2.1]",
  ]),
  suffix: Schema.Literals(["/v1", "/v1/", ""]),
});

it.prop(
  "gateway URLs require HTTPS except numeric loopback, with no URL secrets, query or fragment",
  [Arbitrary.schema(UrlParts)],
  ([parts]) => {
    for (const host of [parts.loopback, parts.remote]) {
      const authority = `${host}:${parts.port}`;

      for (const protocol of ["http", "https", "ftp"]) {
        const base = `${protocol}://${authority}${parts.path}`;
        const endpoint = base + parts.suffix;

        if (
          protocol === "https" ||
          (protocol === "http" && host === parts.loopback)
        ) {
          expect(gatewayUrl(` \n${endpoint}\t`)).toBe(base);
        } else {
          expect(() => gatewayUrl(endpoint)).toThrow();
        }

        for (const invalid of [
          `${protocol}://user:password@${authority}${parts.path}`,
          `${protocol}://user@${authority}${parts.path}`,
          `${endpoint}?key=dummy`,
          `${endpoint}#fragment`,
          `${endpoint}?`,
          `${endpoint}#`,
        ]) {
          expect(() => gatewayUrl(invalid)).toThrow();
        }
      }
    }
  }
);
