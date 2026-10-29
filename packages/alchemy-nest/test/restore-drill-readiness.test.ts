import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import json,pathlib,runpy,sys,tempfile
m=runpy.run_path(sys.argv[1],run_name='fixture')
deadline,lag,total=map(int,sys.argv[2:])
def sample(elapsed,writable):
 return {'elapsedSeconds':elapsed,'collections':{'default':{'total':total,'writable':writable},'rat-king-cells':{'total':total,'writable':total}}}
state=m['weed_wait_state']
assert state([],deadline)=='waiting'
assert state([sample(0,0)],deadline)=='waiting', 'Writable bucket is not writable default storage'
assert state([sample(0,total)],deadline)=='ready', 'Already-ready hosts must pass immediately'
assert state([sample(0,0),sample(lag,total)],deadline)==('ready' if lag<=deadline else 'timeout')
assert state([sample(0,0),sample(deadline,0)],deadline)=='timeout'
assert state([sample(0,0),sample(deadline,0),sample(deadline+1,total)],deadline)=='timeout', 'Late readiness revived a timed-out wait'
try:state([sample(0,total+1)],deadline)
except RuntimeError:pass
else:raise AssertionError('Malformed capacity accepted')
# Shapes follow weed topology_info.go and VolumeLayoutInfo at the binary commit.
ids=list(range(1,total+1));writables=ids[:total//2]
directory={'Topology':{'Layouts':[{'collection':'','writables':writables},{'collection':'rat-king-cells','writables':[total+1]}]}}
node=[{'Id':i,'Collection':''} for i in ids]+[{'Id':total+1,'Collection':'rat-king-cells'}]
volumes={'Volumes':{'DataCenters':{'dc':{'rack':{'one':node,'replica':node}}}}}
normalized=m['weed_volume_sample'](directory,volumes,'rat-king-cells',lag)
assert normalized['collections']=={'default':{'total':total,'writable':total//2},'rat-king-cells':{'total':1,'writable':1}}, normalized
assert normalized['registeredTotal']==total+1, 'Replicas double counted'
assert normalized['elapsedSeconds']==lag and normalized['class']=='weed-volume-readiness'
for malformed in [{},{'Topology':{}},{'Topology':{'Layouts':'wrong'}}]:
 try:m['weed_volume_sample'](malformed,volumes,'rat-king-cells',lag)
 except (RuntimeError,KeyError):pass
 else:raise AssertionError('Unknown status shape became readiness')
secret='SENSITIVE_VALUE_'+str(total)
body=json.dumps({'code':'StorageUnavailable','message':'disk backend did:web:example.invalid token='+secret+' '+'x'*300,'ignored':secret}).encode()
error=m['cell_error_details'](503,body)
assert error['status']==503 and error['endpointPath']=='/cell/' and error['code']=='StorageUnavailable'
assert 'did:web:' not in error['message'] and secret not in json.dumps(error)
assert len(error['message'])<=200 and 'ignored' not in error
plain=m['cell_error_details'](503,b'ownership unavailable')
assert plain['message']=='ownership unavailable' and plain['code'] is None
with tempfile.TemporaryDirectory() as tmp:
 base=pathlib.Path(tmp).resolve();root=base/('restore-drill-'+'a'*32);root.mkdir();private=base/'private';private.mkdir()
 for name in ['celld.stdout','celld.stderr','weed.stderr']:
  (root/(name+'.log')).write_text('first-line\n'+''.join('raw-'+str(i)+'\n' for i in range(500)))
 assert m['retain_private_tails']({},root) is None
 result=pathlib.Path(m['retain_private_tails']({'privateDiagnosticsParent':str(private)},root))
 assert result.parent==private and result.stat().st_mode & 0o777==0o600
 text=result.read_text();assert 'first-line' not in text and text.count('raw-499')==3 and text.count('raw-100')==3
 try:m['retain_private_tails']({'privateDiagnosticsParent':str(private)},root)
 except FileExistsError:pass
 else:raise AssertionError('Existing private evidence overwritten')
print('READINESS_MODEL_PASSED')
`;

it.effect.prop(
  "restored weed waits for default writable storage, passes immediately when ready, and never revives after its deadline",
  {
    deadline: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 300, minimum: 1 }))
    ),
    lag: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 360, minimum: 0 }))
    ),
    total: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 2048, minimum: 1 }))
    ),
  },
  ({ deadline, lag, total }) =>
    Effect.gen(function* readinessModel() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        String(deadline),
        String(lag),
        String(total),
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("READINESS_MODEL_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
