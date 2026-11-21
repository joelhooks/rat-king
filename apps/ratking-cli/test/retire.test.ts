import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Retire from "@rat-king/lexicon/identity.retireName";
import * as Resolve from "@rat-king/lexicon/runtime.resolveLease";
import {
  authenticateClaims,
  ReplayAuthority,
  staticResolver,
} from "@rat-king/mailbox-client";
import { settingsLayer } from "@rat-king/ratking-client/config";
import { Directory, directoryLayer } from "@rat-king/ratking-client/directory";
import { secretName } from "@rat-king/ratking-client/name";
import { SecretStore } from "@rat-king/ratking-client/secrets";
import {
  Clock,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { SecretStore as OperatorStore } from "../../mailbox/cli/secrets.ts";
import { memorySecretStoreLayer } from "../../mailbox/cli/test/secret-store.ts";
import { faulted } from "../src/faults.ts";
import { retireAsName, retireAsOperator } from "../src/operator.ts";
import { ENDPOINT, LEASE_ID, people, SERVICE } from "./fixture.ts";
import type { People } from "./fixture.ts";

const TIME = "2026-01-01T00:00:00.000Z";

const NAME = "tester";

const SUCCESSOR = "peer";

const ScenarioSchema = Schema.Literals([
  "ready",
  "missing",
  "wrong-key",
  "live",
  "bad-successor",
  "raced",
  "unavailable",
]);

type Scenario = typeof ScenarioSchema.Type;

const fixture = Effect.gen(function* fixture() {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* fs.makeTempDirectoryScoped();
  const who = yield* people;

  const config = `${state}/pi.json`;

  yield* fs.writeFileString(
    config,
    JSON.stringify({
      didTemplate: who.tester.did.replace(NAME, "{agent}"),
      endpoint: ENDPOINT,
      serviceDid: SERVICE,
      state,
    })
  );

  const settings = settingsLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ HOME: state, RATKING_CONFIG: config })
      )
    )
  );

  const directory = yield* Directory.pipe(
    Effect.provide(directoryLayer.pipe(Layer.provide(settings)))
  );

  return { config, directory, settings, state, who };
});

const retirementResponse = (scenario: Scenario, receipt: Schema.Json) => {
  if (scenario === "bad-successor") {
    return Response.json(
      { error: "NameNotFound", message: "Successor is not live" },
      { status: 404 }
    );
  }

  if (scenario === "raced") {
    return Response.json(
      { error: "LeaseLive", message: `Reader live until ${TIME}` },
      { status: 409 }
    );
  }

  return Response.json(receipt);
};

const leaseResponse = (who: People, scenario: Scenario) => {
  if (scenario === "live") {
    return Response.json({
      lease: {
        did: who.tester.did,
        expiresAt: TIME,
        generation: 1,
        harness: {
          $type: "sh.mschf.ratking.runtime.lease#pi",
          pid: 1,
          sessionId: "fixture",
        },
        leaseId: LEASE_ID,
      },
    });
  }

  return scenario === "unavailable"
    ? Response.json({ error: "MailboxUnavailable" }, { status: 503 })
    : Response.json({ error: "LeaseNotFound" }, { status: 404 });
};

const mailbox = (
  who: People,
  signer: "tester" | "peer",
  scenario: Scenario,
  successor: boolean
) => {
  const calls: string[] = [];
  const signing = signer === "tester" ? who.testerDocument : who.peerDocument;
  const next = successor ? { successor: SUCCESSOR } : {};

  const receipt = {
    ...next,
    by: signing.id,
    did: who.tester.did,
    name: NAME,
    retiredAt: TIME,
  };

  const http = HttpClient.make((request) =>
    Effect.gen(function* signedCall() {
      const url = new URL(request.url);
      const nsid = url.pathname.replace("/xrpc/", "");
      calls.push(nsid);

      const claims = yield* authenticateClaims({
        audience: `${SERVICE}#mailbox`,
        authorization: request.headers.authorization ?? null,
        now: yield* Clock.currentTimeMillis,
        nsid,
      }).pipe(
        Effect.provide(staticResolver([signing])),
        Effect.provideService(ReplayAuthority, { consume: () => Effect.void })
      );

      expect(claims.iss).toBe(signing.id);

      if (nsid === Resolve.Method.nsid) {
        expect(request.method).toBe("GET");
        expect(url.searchParams.get("did")).toBe(who.tester.did);

        return HttpClientResponse.fromWeb(
          request,
          leaseResponse(who, scenario)
        );
      }

      expect(nsid).toBe(Retire.Method.nsid);
      expect(request.method).toBe("POST");

      if (!Predicate.isTagged(request.body, "Uint8Array")) {
        return yield* Effect.die("expected a JSON retirement body");
      }

      expect(new TextDecoder().decode(request.body.body)).toBe(
        JSON.stringify({ name: NAME, ...next })
      );

      return HttpClientResponse.fromWeb(
        request,
        retirementResponse(scenario, receipt)
      );
    }).pipe(Effect.orDie)
  );

  return { calls, http, receipt };
};

const selfStore = (who: People, scenario: Scenario) => {
  const held = scenario !== "missing";
  const identity = scenario === "wrong-key" ? who.peer : who.tester;

  return SecretStore.of({
    add: () => Effect.die("retirement must never mint a key"),
    exists: (key) => Effect.succeed(held && key === secretName(NAME)),
    lease: (key) =>
      key === secretName(NAME) && held
        ? Effect.succeed(Redacted.make(JSON.stringify(identity)))
        : Effect.die("retirement must never lease another key"),
  });
};

const refused = {
  "bad-successor": {
    calls: [Resolve.Method.nsid, Retire.Method.nsid],
    code: 2,
    tag: "Rejected",
    why: "NameNotFound: Successor is not live",
  },
  live: { calls: [Resolve.Method.nsid], code: 4, tag: "LeaseLive", why: TIME },
  missing: { calls: [], code: 2, tag: "NoIdentity", why: "holds no key" },
  raced: {
    calls: [Resolve.Method.nsid, Retire.Method.nsid],
    code: 4,
    tag: "LeaseLive",
    why: TIME,
  },
  unavailable: {
    calls: [Resolve.Method.nsid],
    code: 2,
    tag: "Rejected",
    why: "nothing was retired",
  },
  "wrong-key": { calls: [], code: 2, tag: "NoIdentity", why: "key not used" },
};

it.effect.prop(
  "self retirement signs as the local name and updates the overlay only after success",
  {
    scenario: ScenarioSchema,
    successor: Schema.Boolean,
  },
  ({ scenario, successor }) =>
    Effect.gen(function* proof() {
      const { directory, settings, who } = yield* fixture;
      const hasSuccessor = successor || scenario === "bad-successor";

      const { calls, http, receipt } = mailbox(
        who,
        "tester",
        scenario,
        hasSuccessor
      );

      const retire = retireAsName(
        NAME,
        hasSuccessor ? Option.some(SUCCESSOR) : Option.none()
      ).pipe(
        Effect.provide(settings),
        Effect.provideService(Directory, directory),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(SecretStore, selfStore(who, scenario))
      );

      if (scenario === "ready") {
        expect(yield* retire).toEqual(receipt);
        expect(calls).toEqual([Resolve.Method.nsid, Retire.Method.nsid]);
        expect(yield* directory.retired).toHaveProperty(NAME);
        expect((yield* directory.retired)[NAME]?.successor).toBe(
          hasSuccessor ? SUCCESSOR : undefined
        );
      } else {
        const failure = yield* Effect.flip(retire);
        const result = faulted(failure, { as: NAME });
        const expected = refused[scenario];
        expect(result.code).toBe(expected.code);
        expect(result.prompt.tag).toBe(expected.tag);
        expect(result.prompt.why).toContain(expected.why);
        expect(calls).toEqual(expected.calls);
        expect(yield* directory.retired).toEqual({});

        if (scenario === "missing") {
          expect(result.prompt.fix).toContain(`ratking retire --name ${NAME}`);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "operator retirement keeps the operator signature, receipt and local overlay",
  [Schema.Boolean],
  ([successor]) =>
    Effect.gen(function* proof() {
      const { config, directory, state, who } = yield* fixture;
      const { calls, http, receipt } = mailbox(who, "peer", "ready", successor);
      const key = "operator-fixture";
      yield* Effect.gen(function* run() {
        const store = yield* OperatorStore;
        yield* store.add(key, JSON.stringify(who.peer));
        expect(
          yield* retireAsOperator(
            NAME,
            successor ? Option.some(SUCCESSOR) : Option.none()
          )
        ).toEqual(receipt);
      }).pipe(
        Effect.provide(memorySecretStoreLayer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              HOME: state,
              RATKING_CONFIG: config,
              RAT_KING_ENDPOINT: ENDPOINT,
              RAT_KING_OPERATOR_IDENTITY: key,
              RAT_KING_SERVICE_DID: SERVICE,
            })
          )
        )
      );
      expect(calls).toEqual([Retire.Method.nsid]);
      expect(yield* directory.retired).toHaveProperty(NAME);
      expect((yield* directory.retired)[NAME]?.successor).toBe(
        successor ? SUCCESSOR : undefined
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
