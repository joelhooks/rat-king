import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import datetime,runpy,sys,types,pathlib
m=runpy.run_path(sys.argv[1],run_name='fixture');state=sys.argv[2];scope=sys.argv[3]
class Clock:
 @staticmethod
 def now(tz):return datetime.datetime(2026,1,1,12,tzinfo=tz)
m['backup_idle'].__globals__['datetime']=types.SimpleNamespace(datetime=Clock,timezone=datetime.timezone)
# Model systemctl show: a missing unit has a successful not-found/inactive read.
for code in [0,1]:
 m['backup_idle'].__globals__['subprocess'].run=lambda *a,**k:types.SimpleNamespace(returncode=code,stdout='LoadState='+('not-found' if state=='missing' else 'loaded')+'\nActiveState='+('inactive' if state=='missing' else state)+'\n')
 try:m['backup_idle']()
 except RuntimeError:assert code!=0 or state not in ['missing','inactive','failed']
 else:assert code==0 and state in ['missing','inactive','failed'], 'Unknown or busy backup accepted'
config={} if scope=='system' else {'isolationScope':scope}
command=m['worker_command'](config,'restore-drill-example.service',pathlib.Path('/scratch/example'))
assert '-p' in command and 'PrivateNetwork=yes' in command and 'KillMode=control-group' in command
control=m['unit_control'](config)
if scope=='user':
 assert command[:2]==['systemd-run','--user'] and 'PrivateUsers=yes' in command
 assert not any(arg.startswith('--uid=') for arg in command)
 assert control==['systemctl','--user']
else:
 assert command[:3]==['sudo','-n','systemd-run'] and any(arg.startswith('--uid=') for arg in command)
 assert control==['sudo','-n','systemctl']
m['unit_cgroup'].__globals__['subprocess'].run=lambda *a,**k:types.SimpleNamespace(returncode=0,stdout='/user.slice/example.slice/test-manager.service/init.scope\n')
group=m['unit_cgroup'](config,'restore-drill-example.service')
assert str(group)==('/sys/fs/cgroup/user.slice/example.slice/test-manager.service/app.slice/restore-drill-example.service' if scope=='user' else '/sys/fs/cgroup/system.slice/restore-drill-example.service')
if scope=='user':
 assert 'Slice=app.slice' in command
 for code,value in [(1,'/user.slice/init.scope'),(0,''),(0,'/user.slice/../init.scope'),(0,'relative/init.scope')]:
  m['unit_cgroup'].__globals__['subprocess'].run=lambda *a,**k:types.SimpleNamespace(returncode=code,stdout=value)
  try:m['unit_cgroup'](config,'restore-drill-example.service')
  except RuntimeError:pass
  else:raise AssertionError('Unknown cgroup accepted for teardown')
for invalid in ['unknown',None,True]:
 try:m['unit_control']({'isolationScope':invalid})
 except RuntimeError:pass
 else:raise AssertionError('Unknown isolation scope accepted')
print('HOST_PROPERTIES_PASSED')
`;

it.effect.prop(
  "backup state fails closed except idle or missing units; both isolation scopes retain the network fence",
  {
    scope: Arbitrary.schema(Schema.Literals(["system", "user"])),
    state: Arbitrary.schema(
      Schema.Literals([
        "missing",
        "inactive",
        "failed",
        "active",
        "activating",
        "",
        "unknown",
      ])
    ),
  },
  ({ scope, state }) =>
    Effect.gen(function* hostProperties() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        state,
        scope,
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("HOST_PROPERTIES_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
