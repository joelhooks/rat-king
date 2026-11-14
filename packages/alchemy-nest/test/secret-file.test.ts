import * as Test from "@alchemy.run/test/Vitest";
import { it } from "@effect/vitest";
import { Arbitrary, Context, Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { renderTemplate, resolveFileContent } from "../src/file-content.ts";
import { textDigest } from "../src/files.ts";
import { HostShell } from "../src/host-shell.ts";
import { RemoteFile, RemoteFileProvider } from "../src/providers.ts";
import { validateFile } from "../src/remote-file.ts";
import { SecretSource } from "../src/secret-source.ts";
import { checkedStack } from "./checked-stack.ts";

const props = {
  contentFrom: { secret: "example-secret" },
  mode: 0o600,
  path: "/home/example/.config/rat-king/token",
};

class Fixture extends Context.Service<
  Fixture,
  { readonly values: Record<string, string> }
>()("Test/SecretFile") {}

const fixture = Layer.effectContext(
  Effect.gen(function* fixture() {
    const fake = yield* makeFakeShell();
    const values = { "example-secret": "fixture-before" };
    const secrets = yield* Layer.build(SecretSource.fromRecord(values));

    return secrets.pipe(
      Context.add(HostShell, fake.shell),
      Context.add(Fixture, { values })
    );
  })
);

const { test } = Test.make({
  providers: RemoteFileProvider().pipe(
    Layer.provideMerge(fixture),
    Layer.orDie
  ),
  stage: "secret-file",
});

test.provider(
  "same secret name rotates by sha and updates without replacing",
  (scratch) =>
    Effect.gen(function* rotate() {
      const stack = checkedStack(scratch);
      const { values } = yield* Fixture;
      const first = yield* stack.deploy(RemoteFile("secret", props));
      values["example-secret"] = "fixture-after";
      const plan = yield* stack.plan(RemoteFile("secret", props));
      expect(plan.resources.secret?.action).toBe("update");
      const second = yield* stack.deploy(RemoteFile("secret", props));
      expect(second.sha256).toBe(textDigest("fixture-after"));
      expect(second.sha256).not.toBe(first.sha256);
      expect(second.contentFrom).toEqual(props.contentFrom);
      const settled = yield* stack.plan(RemoteFile("secret", props));
      expect(settled.resources.secret?.action).toBe("noop");
    })
);

it.prop(
  "template values are escaped once without recursive substitution",
  { text: Arbitrary.schema(Schema.String) },
  ({ text }) => {
    const rendered = renderTemplate(
      {
        format: "json",
        secrets: { KEY: "example-secret" },
        template: '{"nested":{"key":{{KEY}}}}',
      },
      { KEY: text }
    );

    expect(rendered === undefined ? undefined : JSON.parse(rendered)).toEqual({
      nested: { key: text },
    });
  }
);

it.effect.prop(
  "secret references require exactly mode 0600",
  {
    mode: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 0o777, minimum: 0 }))
    ),
  },
  ({ mode }) =>
    Effect.gen(function* permissions() {
      expect(
        yield* validateFile({ ...props, mode }).pipe(Effect.isSuccess)
      ).toBe(mode === 0o600);
    })
);

it.effect(
  "unresolved templates, conflicting sources and missing stores fail closed",
  () =>
    Effect.gen(function* invalidSources() {
      expect(
        renderTemplate({ secrets: {}, template: "{{MISSING}}" }, {})
      ).toBeUndefined();
      expect(
        yield* validateFile({ ...props, content: "inline" }).pipe(
          Effect.isFailure
        )
      ).toBe(true);
      expect(yield* resolveFileContent(props).pipe(Effect.isFailure)).toBe(
        true
      );
      expect(
        yield* validateFile({
          ...props,
          contentFrom: { secret: "invalid name" },
        }).pipe(Effect.isFailure)
      ).toBe(true);
      expect(
        yield* resolveFileContent(props).pipe(
          Effect.provide(SecretSource.fromRecord({})),
          Effect.isFailure
        )
      ).toBe(true);
    })
);
