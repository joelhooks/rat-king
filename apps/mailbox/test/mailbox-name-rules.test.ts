import { it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { expect } from "vitest";

import {
  AgentName,
  decideRegistration,
  DidTemplate,
  fingerprint,
  nameDid,
  publicOnly,
} from "../src/issuer-policy.ts";
import {
  directoryMode,
  isDirectoryMethod,
  projectionViews,
  retiredOutput,
} from "../src/list-names.ts";
import { SeedBatch } from "../src/name-state-seed.ts";
import type { NameState } from "../src/name-state.ts";
import { observedStatus } from "../src/name-state.ts";
import { presenceOf, retiredMessage } from "../src/retirement.ts";
import { resolveRoute } from "../src/roles.ts";
import {
  alpha,
  did,
  epoch,
  integer,
  iso,
  publicDoc,
  serial,
  template,
} from "./mailbox-rule-inputs.ts";

const request = (n: number, name = `project/agent-${n}`) => ({
  document: publicDoc(nameDid(template, name), n),
  enrolled: true,
  host: `host-${n}`,
  name,
});

const decide = (
  candidate: ReturnType<typeof request>,
  options: {
    reserved?: readonly string[];
    staticDids?: readonly string[];
    existing?: Parameters<typeof decideRegistration>[3];
  } = {}
) =>
  decideRegistration(
    { didTemplate: template, reserved: options.reserved ?? [] },
    candidate,
    new Set(options.staticDids),
    options.existing
  );

const bind = (candidate: ReturnType<typeof request>) => ({
  did: candidate.document.id,
  fingerprint: fingerprint(candidate.document),
  host: candidate.host,
});

it.prop(
  "issuer names accept a scoped leaf at the exact length limit",
  [alpha, alpha],
  ([scope, leaf]) => {
    const full = `${scope}/${leaf.padEnd(32, "x")}`;
    expect(Schema.is(AgentName)(full)).toBe(true);
    expect(Schema.is(AgentName)(`${full}x`)).toBe(false);
  }
);

it.prop(
  "a third name segment is never a registration name",
  [alpha, alpha, alpha],
  ([first, second, third]) => {
    expect(Schema.is(AgentName)(`${first}/${second}/${third}`)).toBe(false);
  }
);

it.prop(
  "a DID template must have exactly one agent placeholder and no fragment",
  [alpha],
  ([label]) => {
    const start = `did:web:${label}.invalid`;
    expect(Schema.is(DidTemplate)(`${start}:{agent}`)).toBe(true);
    expect(Schema.is(DidTemplate)(`${start}:{agent}:{agent}`)).toBe(false);
    expect(Schema.is(DidTemplate)(`${start}:{agent}#key`)).toBe(false);
  }
);

it.prop(
  "scoped names map to a dot in the substituted DID, not an extra path level",
  [alpha, alpha],
  ([scope, name]) => {
    expect(nameDid(template, `${scope}/${name}`)).toBe(
      `did:web:example.invalid:actors:${scope}.${name}`
    );
  }
);

it.prop(
  "an unenrolled host cannot register even with an exact public document",
  [serial],
  ([n]) => {
    expect(decide({ ...request(n), enrolled: false })).toEqual(
      Result.fail("Forbidden")
    );
  }
);

it.prop(
  "registration rejects a malformed name even if its calculated DID matches",
  [serial, alpha],
  ([n, stem]) => {
    expect(decide(request(n, `group/${stem}/nested`))).toEqual(
      Result.fail("InvalidName")
    );
  }
);

it.prop(
  "the exact reservation cannot be bound by a host, but does not reserve a prefix",
  [serial],
  ([n]) => {
    const candidate = request(n);
    const reserved = [candidate.name];
    expect(decide(candidate, { reserved })).toEqual(
      Result.fail("NameReserved")
    );
    expect(
      Result.isSuccess(
        decide(request(n, `${candidate.name}-extra`), { reserved })
      )
    ).toBe(true);
  }
);

it.prop(
  "a public document bound to another name cannot authorize a registration",
  [serial],
  ([n]) => {
    expect(
      decide({ ...request(n), document: request(n + 1).document })
    ).toEqual(Result.fail("InvalidRequest"));
  }
);

it.prop(
  "a static identity remains static even with a matching preexisting binding",
  [serial],
  ([n]) => {
    const candidate = request(n);
    expect(
      decide(candidate, {
        existing: bind(candidate),
        staticDids: [candidate.document.id],
      })
    ).toEqual(Result.fail("StaticIdentity"));
  }
);

it.prop(
  "a new registration binds the same document fingerprint used for repeat detection",
  [serial],
  ([n]) => {
    const candidate = request(n);
    const binding = bind(candidate);
    expect(decide(candidate)).toEqual(
      Result.succeed({ binding, did: binding.did, kind: "bind" })
    );
    expect(decide(candidate, { existing: binding })).toEqual(
      Result.succeed({ binding, did: binding.did, kind: "repeat" })
    );
  }
);

it.prop(
  "a different host cannot replay an existing name with its original document",
  [serial],
  ([n]) => {
    const candidate = request(n);
    expect(
      decide(
        { ...candidate, host: `other-${n}` },
        { existing: bind(candidate) }
      )
    ).toEqual(Result.fail("NameTaken"));
  }
);

it.prop(
  "the same host cannot rotate a bound name by changing its registration document",
  [serial],
  ([n]) => {
    const candidate = request(n);
    expect(
      decide(
        { ...candidate, document: publicDoc(candidate.document.id, n + 1) },
        { existing: bind(candidate) }
      )
    ).toEqual(Result.fail("NameTaken"));
  }
);

it.prop(
  "reordering document object fields does not change its canonical fingerprint",
  [serial],
  ([n]) => {
    const original = publicDoc(did(n), n);
    const { authentication, id, keyAgreement, verificationMethod } = original;
    expect(
      fingerprint({ authentication, id, keyAgreement, verificationMethod })
    ).toBe(fingerprint(original));
  }
);

it.prop(
  "public-only issuer decoding fails closed on unknown fields",
  [serial, alpha],
  ([n, field]) => {
    const doc = publicDoc(did(n), n);
    expect(publicOnly(doc)).toEqual(Option.some(doc));
    expect(publicOnly({ ...doc, [`extra-${field}`]: n })).toEqual(
      Option.none()
    );
  }
);

it.prop(
  "issuer decoding rejects non-P-256 public coordinates instead of accepting an unsupported curve",
  [serial, alpha],
  ([n, curve]) => {
    const doc = publicDoc(did(n), n);

    const verificationMethod = doc.verificationMethod.map((method) => ({
      ...method,
      publicKeyJwk: { ...method.publicKeyJwk, crv: curve },
    }));

    expect(publicOnly({ ...doc, verificationMethod })).toEqual(Option.none());
  }
);

const views = Schema.Array(
  Schema.Literals(["names", "retired", "snapshot"])
).check(Schema.isMaxLength(9));

it.prop(
  "projection view switches are order-independent and duplicate-insensitive",
  [views],
  ([flags]) => {
    const first = projectionViews(flags.join(","));
    expect(
      projectionViews([...flags.toReversed(), ...flags].join(","))
    ).toEqual(first);
    expect(first).toEqual({
      names: flags.includes("names"),
      retired: flags.includes("retired"),
      snapshot: flags.includes("snapshot"),
    });
  }
);

it.prop(
  "an explicit unrecognized projection config degrades instead of using bootstrap",
  [alpha],
  ([flag]) => {
    expect(directoryMode(`unknown-${flag}`)).toBe("degraded");
    expect(directoryMode()).toBe("bootstrap");
  }
);

it.prop(
  "one legitimate view activates projection even among unrecognized view tokens",
  [alpha, Schema.Literals(["names", "retired", "snapshot"])],
  ([flag, view]) => {
    expect(directoryMode(`unknown-${flag},${view}`)).toBe("projected");
  }
);

it.prop(
  "the directory selector never matches a near prefix or query suffix",
  [alpha, Schema.Literals(["listNames", "listRetired"])],
  ([tag, method]) => {
    const nsid = `sh.mschf.ratking.identity.${method}`;
    expect(isDirectoryMethod(nsid)).toBe(true);
    expect(isDirectoryMethod(`${nsid}.${tag}`)).toBe(false);
  }
);

const observation = (n: number, at: number): typeof NameState.Type => ({
  did: did(n),
  leaseExpiresAt: at,
  leaseGeneration: n,
  observedAt: at - n,
  retirement: null,
  version: n,
});

const retirement = (n: number, at: number) => ({
  by: did(n + 1),
  name: `retired-${n}`,
  retiredAt: at,
});

it.prop(
  "presence expires at the exact recorded instant, not one tick later",
  [serial, epoch],
  ([n, expires]) => {
    const state = observation(n, expires);
    expect(observedStatus(state, expires - 1)).toBe("live");
    expect(observedStatus(state, expires)).toBe("idle");
  }
);

it.prop(
  "retirement wins over a future lease in the observed status",
  [serial, epoch],
  ([n, now]) => {
    expect(
      observedStatus(
        { ...observation(n, now + n), retirement: retirement(n, now) },
        now
      )
    ).toBe("retired");
  }
);

it.prop(
  "older observation timestamps alone cannot make an unexpired name idle",
  [serial, epoch],
  ([n, now]) => {
    const state = observation(n, now + n);
    expect(
      observedStatus({ ...state, observedAt: now - 3 * 86_400_000 }, now)
    ).toBe("live");
  }
);

it.prop(
  "a seeded batch can contain one through one hundred names, but no more",
  [serial, epoch, integer(1, 100)],
  ([n, now, count]) => {
    const batch = (size: number) => ({
      rows: Array.from({ length: size }, (_, i) => ({
        state: observation(n + i, now),
      })),
    });

    expect(Schema.is(SeedBatch)(batch(count))).toBe(true);
    expect(Schema.is(SeedBatch)(batch(101))).toBe(false);
  }
);

it.prop(
  "a bad embedded document invalidates an otherwise legitimate seed batch",
  [serial, epoch],
  ([n, now]) => {
    expect(
      Schema.is(SeedBatch)({
        rows: [
          { state: observation(n, now) },
          { document: { id: did(n + 1) }, state: observation(n + 1, now) },
        ],
      })
    ).toBe(false);
  }
);

it.prop(
  "retired views serialize optional clocks independently and leave an absent successor absent",
  [serial, epoch, Schema.Boolean],
  ([n, at, updated]) => {
    const row = {
      ...retirement(n, at),
      did: did(n),
      ...(updated ? { updatedAt: at + n } : { observedAt: at + n }),
    };

    expect(retiredOutput(row)).toEqual({
      by: row.by,
      did: row.did,
      name: row.name,
      retiredAt: iso(at),
      ...(updated ? { updatedAt: iso(at + n) } : { observedAt: iso(at + n) }),
    });
  }
);

it.prop(
  "a held reader reports its renders and the observation instant only while live",
  [serial, epoch, alpha],
  ([n, at, faction]) => {
    const renders = [`sh.example.${faction}`];

    const lease = {
      expiresAt: at,
      generation: n,
      leaseId: `lease-${n}`,
      renders,
    };

    expect(presenceOf(lease, at - 1)).toEqual({
      held: true,
      lastHeldAt: at - 1,
      renders,
    });
    expect(presenceOf(lease, at)).toEqual({ held: false, lastHeldAt: at });
  }
);

it.prop(
  "retired evidence names the successor without rewriting the original retirement time",
  [serial, epoch, alpha],
  ([n, at, successor]) => {
    const row = retirement(n, at);
    expect(retiredMessage(row)).toBe(
      `${row.name} was retired at ${iso(at)}; no successor`
    );
    expect(retiredMessage({ ...row, successor, updatedAt: at + n })).toBe(
      `${row.name} was retired at ${iso(at)}; current row is ${successor}`
    );
  }
);

it.effect.prop(
  "a self-role stays on the current name long enough to check its successor",
  [serial, epoch],
  ([n, at]) =>
    Effect.gen(function* selfRole() {
      const row = retirement(n, at);
      const successor = `successor-${n}`;

      const route = yield* resolveRoute(row.name, {
        retired: (name) =>
          Effect.succeed(
            name === row.name
              ? Option.some({ ...row, successor })
              : Option.none()
          ),
        role: (name) => Effect.succeed(name === row.name ? name : undefined),
      });

      expect(route).toEqual({ chain: [row.name, successor], name: successor });
    })
);

it.effect.prop(
  "a real role redirect takes precedence over the same row's retirement lineage",
  [serial, epoch],
  ([n, at]) =>
    Effect.gen(function* roleFirst() {
      const row = retirement(n, at);
      const target = `target-${n}`;

      const route = yield* resolveRoute(row.name, {
        retired: (name) =>
          Effect.succeed(
            name === row.name
              ? Option.some({ ...row, successor: `wrong-${n}` })
              : Option.none()
          ),
        role: (name) => Effect.succeed(name === row.name ? target : undefined),
      });

      expect(route.name).toBe(target);
      expect(route.chain).toEqual([row.name, target]);
    })
);
