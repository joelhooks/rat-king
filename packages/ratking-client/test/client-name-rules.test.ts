import { it } from "@effect/vitest";
import { Option, Result, Schema } from "effect";
import { expect } from "vitest";

import {
  addressedElsewhere,
  AgentName,
  canonicalName,
  deriveName,
  didFor,
  isReserved,
  labelSlug,
  nameFor,
  provisionLabel,
  sessionName,
  verifiedSender,
} from "../src/name.ts";
import { alpha, id, template } from "./client-rule-inputs.ts";

const names = (n: number) => ({
  alias: `alias-${n}`,
  canonical: `project/desk-${n}`,
  did: `did:web:example.invalid:fixed:${n}`,
});

const fixed = (n: number) => {
  const { alias, canonical, did } = names(n);

  return { [canonical]: { aliases: [alias], did } };
};

const request = {
  env: Option.none(),
  pane: Option.none(),
  reserved: {},
  session: "fixture",
  taken: () => false,
};

it.prop(
  "provisioned names have a single DNS-safe separator without changing either side",
  [alpha(10), alpha(10)],
  ([project, desk]) => {
    expect(provisionLabel(`${project}/${desk}`)).toBe(`${project}.${desk}`);
    expect(provisionLabel(desk)).toBe(desk);
  }
);

it.prop(
  "a reserved alias and its canonical name share the fixed DID",
  [id],
  ([n]) => {
    const { alias, canonical, did } = names(n);
    expect(didFor(template, fixed(n), alias)).toBe(did);
    expect(didFor(template, fixed(n), canonical)).toBe(did);
    expect(nameFor(template, fixed(n), did)).toEqual(Option.some(canonical));
  }
);

it.prop(
  "canonicalization is idempotent and does not claim a near-match alias",
  [id],
  ([n]) => {
    const { alias, canonical } = names(n);
    const reserved = fixed(n);
    expect(canonicalName(reserved, canonicalName(reserved, alias))).toBe(
      canonical
    );
    expect(isReserved(reserved, alias)).toBe(true);
    expect(isReserved(reserved, `${alias}-extra`)).toBe(false);
  }
);

it.prop(
  "a generated DID for a fixed name cannot be reverse-resolved as that reserved name",
  [id],
  ([n]) => {
    const { canonical } = names(n);
    const unfixed = didFor(template, {}, canonical);
    expect(nameFor(template, fixed(n), unfixed)).toEqual(Option.none());
  }
);

it.prop(
  "reverse lookup requires both exact template boundaries",
  [alpha(12)],
  ([name]) => {
    const did = didFor(template, {}, name);
    expect(nameFor(template, {}, `x${did}`)).toEqual(Option.none());
    expect(nameFor(template, {}, `${did}x`)).toEqual(Option.none());
  }
);

it.prop(
  "reverse lookup does not interpret an extra dot as part of a scoped agent name",
  [alpha(12), alpha(12)],
  ([project, desk]) => {
    const invalid = template.replace("{agent}", `${project}.${desk}.tail`);
    expect(nameFor(template, {}, invalid)).toEqual(Option.none());
  }
);

it.prop(
  "address checking accepts aliases only for the matching canonical recipient",
  [id],
  ([n]) => {
    const { alias, canonical } = names(n);
    expect(addressedElsewhere(fixed(n), alias, canonical)).toBe(false);
    expect(addressedElsewhere(fixed(n), alias, `${canonical}-other`)).toBe(
      true
    );
  }
);

it.prop(
  "verified senders may use a directory-known identity name without relying on the template",
  [alpha(12), id],
  ([claimed, n]) => {
    const did = `did:web:example.invalid:foreign:${n}`;
    const sender = { claimed, did, reserved: {}, template };
    expect(verifiedSender({ ...sender, known: Option.some(claimed) })).toBe(
      true
    );
    expect(verifiedSender({ ...sender, known: Option.none() })).toBe(false);
  }
);

it.prop(
  "a non-name never verifies via template substitution alone",
  [alpha(10)],
  ([part]) => {
    const claimed = `${part}//demo`;
    expect(
      verifiedSender({
        claimed,
        did: didFor(template, {}, claimed),
        known: Option.none(),
        reserved: {},
        template,
      })
    ).toBe(false);
  }
);

it.prop(
  "an explicit environment pick canonicalizes a reserved alias even if automatic selection is taken",
  [id],
  ([n]) => {
    const { alias, canonical } = names(n);
    expect(
      deriveName({
        ...request,
        env: Option.some(alias),
        pane: Option.some("available-pane"),
        reserved: fixed(n),
        taken: () => true,
      })
    ).toEqual(Result.succeed({ name: canonical, source: "env" }));
  }
);

it.prop(
  "an invalid explicit name is a refusal rather than an automatic fallback",
  [alpha(12)],
  ([part]) => {
    const result = deriveName({
      ...request,
      env: Option.some(`${part}/`),
      pane: Option.some("working-pane"),
    });

    expect(Result.isFailure(result)).toBe(true);
  }
);

it.prop(
  "an occupied pane falls back to the session, never the occupied name",
  [alpha(12), id],
  ([pane, n]) => {
    const session = `fixture-${n}`;

    const result = deriveName({
      ...request,
      pane: Option.some(pane),
      session,
      taken: (name) => name === pane,
    });

    expect(result).toEqual(
      Result.succeed({ name: `pi-${session}`, source: "session" })
    );
  }
);

it.prop(
  "a pane label colliding with a reserved alias cannot claim that alias automatically",
  [id],
  ([n]) => {
    const { alias } = names(n);
    expect(
      deriveName({
        ...request,
        pane: Option.some(alias.toUpperCase()),
        reserved: fixed(n),
      })
    ).toEqual(Result.succeed({ name: "pi-fixture", source: "session" }));
  }
);

it.prop(
  "only punctuation separates stable pane slug components",
  [alpha(10), alpha(10), id],
  ([left, right, n]) => {
    expect(
      labelSlug(`${n} – ${left.toUpperCase()} / ${right.toUpperCase()}`)
    ).toEqual(Option.some(`${left}-${right}`));
  }
);

it.prop(
  "long session names always fit a valid agent segment despite unknown punctuation",
  [Schema.String, alpha(10)],
  ([raw, tail]) => {
    const name = sessionName(`${raw}!${tail.repeat(16)}?`);
    expect(name).toMatch(/^pi-/u);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(Schema.is(AgentName)(name)).toBe(true);
  }
);
