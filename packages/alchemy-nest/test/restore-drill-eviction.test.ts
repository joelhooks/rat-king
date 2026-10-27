import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import json,pathlib,runpy,sys,tempfile,urllib.error
m=runpy.run_path(sys.argv[1],run_name='fixture');kind=sys.argv[2];status=int(sys.argv[3]);private='PRIVATE_EVICTION_REASON'
def call(*args):
 if kind=='http':raise urllib.error.HTTPError('http://example.invalid',status,private,None,None)
 if kind=='transport':raise urllib.error.URLError(private)
 if kind=='unexpected':raise ValueError(private)
 return {'ok':kind=='evicted'}
m['deactivate_mailboxes'].__globals__['http_json']=call
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);ok=m['deactivate_mailboxes'](root,1,['Mailbox:fixture'])
 record=json.loads((root/'deactivations.json').read_text())[0]
 assert ok==(kind=='evicted') and record['deactivated']==ok
 expected={'evicted':'EVICTED','unconfirmed':'NOT_CONFIRMED','http':'HTTP_REJECTED','transport':'TRANSPORT_ERROR','unexpected':'EVICTION_ERROR'}
 assert record['code']==expected[kind],record
 assert ('status' in record)==(kind=='http')
 if kind=='http':assert record['status']==status
 assert private not in json.dumps(record)
print('EVICTION_CODES_PASSED')
`;

it.effect.prop(
  "eviction outcomes distinguish confirmed, unconfirmed, HTTP, transport and unexpected errors without retaining reasons",
  {
    kind: Arbitrary.schema(
      Schema.Literals([
        "evicted",
        "unconfirmed",
        "http",
        "transport",
        "unexpected",
      ])
    ),
    status: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 400 }))
    ),
  },
  ({ kind, status }) =>
    Effect.gen(function* evictionCodes() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        kind,
        String(status),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("EVICTION_CODES_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
