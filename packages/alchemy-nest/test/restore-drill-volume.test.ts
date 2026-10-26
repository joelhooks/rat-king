import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import pathlib,runpy,sys,tempfile,types
m=runpy.run_path(sys.argv[1],run_name='fixture');maximum=int(sys.argv[2]);variant=sys.argv[3]
flag=('-volume.max '+str(maximum)) if variant=='space' else '-volume.max='+str(maximum)
assert m['parse_volume_max']('{ path=/opt/example/weed; argv[]=/opt/example/weed server '+flag+'; ignore_errors=no; }')==maximum
for invalid in ['', '-volume.max=0', '-volume.max=-1', '-volume.max=32,32', '-volume.max=32 -volume.max=64']:
 try:m['parse_volume_max']('argv[]=/opt/example/weed server '+invalid)
 except RuntimeError:pass
 else:raise AssertionError('Ambiguous or absent live limit accepted')
m['live_volume_max'].__globals__['subprocess'].run=lambda *a,**k:types.SimpleNamespace(returncode=1,stdout='')
try:m['live_volume_max']()
except RuntimeError:pass
else:raise AssertionError('Unreadable live unit accepted')
print('LIVE_LIMIT_PASSED')
`;

const boundaryFixture = String.raw`
import pathlib,runpy,sys,tempfile
m=runpy.run_path(sys.argv[1],run_name='fixture');maximum=int(sys.argv[2]);count=maximum-16
m['require_volume_slots'](count,maximum)
try:m['require_volume_slots'](count+1,maximum)
except RuntimeError as error:assert str(error)==f'restore needs {maximum+1} volume slots, max {maximum}'
else:raise AssertionError('Headroom boundary was not enforced')
for invalid in [(-1,maximum),(0,0),(True,maximum)]:
 try:m['require_volume_slots'](*invalid)
 except RuntimeError:pass
 else:raise AssertionError('Invalid capacity accepted')
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);pairs=maximum%11
 for i in range(pairs):
  (root/(str(i)+'.dat')).touch();(root/(str(i)+'.idx')).touch()
 (root/'orphan.idx').touch();(root/'not-a-volume.dat').mkdir();(root/'ignored.vif').touch()
 assert m['restored_volume_count'](root)==pairs+1, 'Volume pairs double-counted or index-only slot ignored'
print('VOLUME_BOUNDARY_PASSED')
`;

it.effect.prop(
  "live volume limit parsing refuses missing, automatic, ambiguous and unreadable values",
  {
    maximum: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 17 }))
    ),
    variant: Arbitrary.schema(Schema.Literals(["space", "equals"])),
  },
  ({ maximum, variant }) =>
    Effect.gen(function* liveLimit() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        maximum.toString(),
        variant,
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("LIVE_LIMIT_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "restored volume pairs require sixteen free slots and enforce the exact boundary",
  {
    maximum: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 17 }))
    ),
  },
  ({ maximum }) =>
    Effect.gen(function* volumeBoundary() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        boundaryFixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        maximum.toString(),
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("VOLUME_BOUNDARY_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
