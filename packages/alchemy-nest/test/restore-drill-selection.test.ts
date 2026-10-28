import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import contextlib,hashlib,json,pathlib,runpy,sqlite3,sys,tempfile
m=runpy.run_path(sys.argv[1],run_name='fixture')
fault=sys.argv[2]
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);dids=['did:web:reader.example.invalid','did:web:desk.example.invalid']
 scopes=['Mailbox:reader','Mailbox:desk','Mailbox:foreign']
 for scope,did in zip(scopes,[*dids,'did:web:foreign.example.invalid']):
  p=root/'celld'/scope/'ltx/e1/db.sqlite';p.parent.mkdir(parents=True)
  with contextlib.closing(sqlite3.connect(p)) as db, db:
   db.executescript('CREATE TABLE _cf_METADATA(actor_name TEXT); CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE messages(tid TEXT,sender TEXT); CREATE TABLE events(seq INTEGER); CREATE TABLE lease(singleton INTEGER,value TEXT);')
   db.execute('INSERT INTO _cf_METADATA VALUES (?)',(did,))
   db.execute('INSERT INTO metadata VALUES (?,?)',('recipient',did))
   db.execute('INSERT INTO messages VALUES (?,?)',('saved-newest','did:web:sender.example.invalid'))
   db.execute('INSERT INTO events VALUES (1)')
   db.execute('INSERT INTO lease VALUES (1,?)',(json.dumps({'did':did,'leaseId':'saved','generation':1,'expiresAt':1}),))
 if fault=='missing-actor':
  with contextlib.closing(sqlite3.connect(root/'celld'/scopes[1]/'ltx/e1/db.sqlite')) as db, db:db.execute('DELETE FROM _cf_METADATA')
 if fault=='empty-message':
  with contextlib.closing(sqlite3.connect(root/'celld'/scopes[0]/'ltx/e1/db.sqlite')) as db, db:db.execute('DELETE FROM messages')
 if fault=='cold-cache':
  with contextlib.closing(sqlite3.connect(root/'celld'/scopes[0]/'ltx/e1/db.sqlite')) as db, db:db.execute('DROP TABLE metadata')
 expected={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('db.sqlite')}
 calls=[];active=set()
 def request(port,path,payload=None):
  command,scope=path.strip('/').split('/',1)
  assert scope in scopes[:2], 'Foreign cached actor activated'
  calls.append((command,scope))
  if command=='cell':
   assert not active,'More than one mailbox active during inspection'
   if fault=='cold-cache' and scope==scopes[0]:
    p=root/'celld'/scope/'ltx/e1/db.sqlite'
    with contextlib.closing(sqlite3.connect(p)) as db, db:
     db.execute('CREATE TABLE metadata(key TEXT,value TEXT)')
     db.execute('INSERT INTO metadata VALUES (?,?)',('recipient',dids[0]))
    expected[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
   active.add(scope);return {'route':'local'}
  assert command=='evict' and payload=={}
  if fault=='eviction':return {'ok':False}
  active.discard(scope);return {'ok':True}
 m['inspect_mailboxes'].__globals__['http_json']=request
 success=fault in ('none','cold-cache')
 try:
  result=m['inspect_mailboxes'](root,1,dids,dids[1])
 except RuntimeError:
  assert not success
 else:
  assert success
  assert result['newest']['recipientDid']==dids[0]
  assert result['lease']['did']==dids[1]
  assert [box['did'] for box in result['mailboxes']]==dids
  assert calls==[('cell',scopes[0]),('evict',scopes[0]),('cell',scopes[1]),('evict',scopes[1])]
  calls.clear()
  m['inspect_mailboxes'](root,1,dids,dids[1],activate=False)
  assert calls==[], 'Read-only final inspection sent a network request'
 if fault=='missing-actor':assert calls==[], 'Discovery sent HTTP before both identities were found'
 if fault!='eviction':assert not active
 assert expected=={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('db.sqlite')}
print('NAMED_SELECTION_PASSED')
`;

const budgetFixture = String.raw`
import contextlib,gc,pathlib,resource,runpy,sqlite3,sys,tempfile
m=runpy.run_path(sys.argv[1],run_name='fixture');counts=[int(c) for c in sys.argv[2].split(',')]
dids=['did:web:reader.example.invalid','did:web:desk.example.invalid']
hard=resource.getrlimit(resource.RLIMIT_NOFILE)[1]
budget=min(64,hard) if hard!=resource.RLIM_INFINITY else 64
resource.setrlimit(resource.RLIMIT_NOFILE,(budget,hard));gc.disable()
assert resource.getrlimit(resource.RLIMIT_NOFILE)[0]<=64
fd_dir=pathlib.Path('/proc/self/fd')
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);built=0
 for count in counts:
  for i in range(built,count):
   p=root/'celld'/('Mailbox:'+str(i))/'ltx/e1/db.sqlite';p.parent.mkdir(parents=True)
   with contextlib.closing(sqlite3.connect(p)) as db, db:
    db.execute('CREATE TABLE _cf_METADATA(actor_name TEXT)')
    db.execute('INSERT INTO _cf_METADATA VALUES (?)',(dids[i] if i<2 else 'did:web:foreign.example.invalid',))
  built=count
  before=len(list(fd_dir.iterdir())) if fd_dir.exists() else None
  for iteration in range(4):
   selected=m['select_mailboxes'](root,dids)
   assert set(selected)==set(dids)
   if before is not None:assert len(list(fd_dir.iterdir()))==before, 'SQLite read loop leaked handles'
print('HANDLE_BUDGET_PASSED')
`;

const cleanupFixture = String.raw`
import runpy,sys
m=runpy.run_path(sys.argv[1],run_name='fixture');primary=sys.argv[2]=='true'
def fail_cleanup(*args):raise OSError(24,'test retention failure')
m['retain_worker_diagnostics'].__globals__['retain_diagnostics']=fail_cleanup
try:
 try:
  if primary:raise RuntimeError('Named proof mailbox missing from restored cache')
 finally:m['retain_worker_diagnostics']({},None,[])
except RuntimeError as error:
 assert primary and str(error)=='Named proof mailbox missing from restored cache'
except OSError as error:
 assert not primary and error.errno==24
else:assert False, 'Failure was swallowed'
print('ERROR_PRECEDENCE_PASSED')
`;

it.effect.prop(
  "cold discovery uses celld identity before app metadata, activates only two named actors and evicts each",
  {
    fault: Arbitrary.schema(
      Schema.Literals([
        "none",
        "cold-cache",
        "missing-actor",
        "empty-message",
        "eviction",
      ])
    ),
  },
  ({ fault }) =>
    Effect.gen(function* namedSelection() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        fault,
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("NAMED_SELECTION_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "SQLite cache discovery closes every handle within a fixed open-files budget without garbage collection",
  () =>
    Effect.gen(function* handleBudget() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        budgetFixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        "80,112,144",
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("HANDLE_BUDGET_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "diagnostic cleanup preserves the discovery error but remains fatal when it is the primary failure",
  { primary: Arbitrary.schema(Schema.Boolean) },
  ({ primary }) =>
    Effect.gen(function* primaryErrorFirst() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        cleanupFixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        primary.toString(),
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("ERROR_PRECEDENCE_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
