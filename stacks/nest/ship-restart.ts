import { Config, Effect, FileSystem, Option, Schema } from "effect";

import { HostError } from "../../packages/alchemy-nest/src/host-shell.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import { RestartEvent, ShipAttempt } from "./ship-config.ts";

export const restartScript = String.raw`
import datetime, fcntl, json, os, pathlib, subprocess, sys, tempfile, time
settings = json.loads(sys.argv[1])
mode = sys.argv[2]
policy = settings['restart']
def defer(at):
    print(json.dumps(dict(retryAt=at)), flush=True)
    sys.exit(75)
def state():
    result = subprocess.run(['systemctl','--user','show',policy['unit'],'-p','ActiveState','-p','InvocationID','-p','ActiveEnterTimestampMonotonic','-p','ActiveExitTimestampMonotonic','-p','Requires'], capture_output=True, text=True)
    if result.returncode != 0: sys.exit(2)
    return dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
def window(at):
    value = policy.get('window')
    if value is None: return at
    start, end = value['startHourUTC'], value['endHourUTC']
    moment = datetime.datetime.fromtimestamp(at, datetime.timezone.utc)
    hour = moment.hour + moment.minute/60 + moment.second/3600
    inside = start == end or (start <= hour < end if start < end else hour >= start or hour < end)
    if inside: return at
    next_start = moment.replace(hour=start, minute=0, second=0, microsecond=0)
    if next_start.timestamp() <= at: next_start += datetime.timedelta(days=1)
    return next_start.timestamp()
try:
    before = state() if mode != 'probe' else None
    if mode != 'probe':
        names = [policy['unit'], *policy.get('dependencies',[]), *before.get('Requires','').split()]
        if not any(name in sys.argv[3:] for name in names):
            result = subprocess.run(sys.argv[3:], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(json.dumps(dict(code=result.returncode,durationSeconds=0,restarted=False)),flush=True)
            sys.exit(result.returncode)
    lock, marker = pathlib.Path(policy['lock']), pathlib.Path(policy['marker'])
    if any(p.is_symlink() for path in [lock,marker] for p in [path,*path.parents]): sys.exit(2)
    with open(lock,'a') as held:
        try: fcntl.flock(held,fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: defer(time.time()+60)
        now = time.time()
        previous = json.loads(marker.read_text()) if marker.exists() else None
        if previous is not None and (not isinstance(previous.get('started'),(int,float)) or previous['started'] < 0 or previous.get('phase') not in ['restarting','done']): sys.exit(2)
        at = now
        if previous is not None and previous.get('sha') != settings['sha']:
            at = max(at,previous['started']+policy.get('minIntervalHours',6)*3600)
        if previous is None or previous.get('sha') != settings['sha']: at = window(at)
        if at > now: defer(at)
        for unit in policy['units']:
            check = subprocess.run(['systemctl','--user','show',unit,'-p','ActiveState','--value'],capture_output=True,text=True)
            if check.returncode != 0 or check.stdout.strip() not in ['inactive','failed','active','activating','deactivating']: sys.exit(2)
            if check.stdout.strip() in ['active','activating','deactivating']: defer(now+60)
        if mode == 'probe': sys.exit(0)
        marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        def mark(phase,started,sha=settings['sha']):
            fd,name = tempfile.mkstemp(dir=marker.parent)
            with os.fdopen(fd,'w') as target:
                json.dump(dict(sha=sha,started=started,phase=phase),target)
                target.flush(); os.fsync(target.fileno())
            os.replace(name,marker)
        started = previous['started'] if previous is not None and previous.get('sha') == settings['sha'] and previous['phase'] == 'restarting' else now
        mark('restarting',started)
        result = subprocess.run(sys.argv[3:],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        after = state()
        changed = after.get('InvocationID','') != before.get('InvocationID','')
        active = after.get('ActiveState') == 'active'
        entered = int(after.get('ActiveEnterTimestampMonotonic','0'))
        exited = int(after.get('ActiveExitTimestampMonotonic','0'))
        duration = max(0,(entered-exited)/1000000) if changed and active and exited > 0 else 0
        if not changed and result.returncode == 0:
            if previous is None: marker.unlink()
            else: mark(previous['phase'],previous['started'],previous['sha'])
        else: mark('done' if active or result.returncode != 0 else 'restarting',started)
        print(json.dumps(dict(code=result.returncode,durationSeconds=duration,restarted=changed if result.returncode == 0 and active else None)),flush=True)
        sys.exit(result.returncode)
except Exception:
    sys.exit(2)
`;

const attempt = Config.option(
  Config.schema(Schema.fromJsonString(ShipAttempt), "RAT_KING_SHIP_ATTEMPT")
);

const DeferredResult = Schema.Struct({ retryAt: Schema.Number });

const RestartResult = Schema.Struct({
  code: Schema.Int,
  durationSeconds: Schema.Number,
  restarted: Schema.NullOr(Schema.Boolean),
});

export const appendRestartEvent = Effect.fn("Ship.appendRestartEvent")(
  function* appendRestartEvent(
    settings: typeof ShipAttempt.Type,
    event: typeof RestartEvent.Type
  ) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      settings.events,
      `${yield* Schema.encodeEffect(Schema.fromJsonString(RestartEvent))(event)}\n`,
      { flag: "a", mode: 0o600 }
    );
  }
);

const deferred = Effect.fn("Ship.recordDeferred")(function* recordDeferred(
  settings: typeof ShipAttempt.Type,
  stdout: string
) {
  const decoded = yield* Schema.decodeEffect(
    Schema.fromJsonString(DeferredResult)
  )(stdout).pipe(
    Effect.mapError(
      () =>
        new HostError({
          operation: "ship",
          reason: "Invalid restart deferral response",
        })
    )
  );

  yield* appendRestartEvent(settings, {
    durationSeconds: 0,
    phase: "deferred",
    restarted: false,
    retryAt: decoded.retryAt,
  });

  return yield* new HostError({
    operation: "ship",
    reason: "Restart policy excludes this attempt",
  });
});

const checked = Effect.fn("Ship.checkRestart")(function* checked(
  shell: Interface,
  settings: typeof ShipAttempt.Type
) {
  const result = yield* shell.exec([
    "python3",
    "-c",
    restartScript,
    JSON.stringify(settings),
    "probe",
  ]);

  if (result.code === 75) {
    return yield* deferred(settings, result.stdout);
  }

  if (result.code !== 0) {
    return yield* new HostError({
      operation: "ship",
      reason: "Restart guard could not establish maintenance state",
    });
  }

  return yield* Effect.void;
});

export const guardRestartPlan = Effect.fn("Ship.guardRestartPlan")(
  function* guardRestartPlan(shell: Interface, restarting: boolean) {
    const settings = yield* attempt;

    if (restarting && Option.isSome(settings)) {
      return yield* checked(shell, settings.value);
    }

    return yield* Effect.void;
  }
);

export const guardedShell = Effect.fn("Ship.guardedShell")(
  function* guardedShell(shell: Interface) {
    const settings = yield* attempt;

    if (Option.isNone(settings)) {
      return shell;
    }

    const target = settings.value;
    const fs = yield* FileSystem.FileSystem;

    return {
      ...shell,
      exec: Effect.fn("Ship.remoteCommand")(
        function* remoteCommand(argv, diagnostics) {
          if (
            argv[0] !== "systemctl" ||
            !argv.some((arg) => ["restart", "start"].includes(arg))
          ) {
            return yield* shell.exec(argv, diagnostics);
          }

          yield* appendRestartEvent(target, {
            durationSeconds: 0,
            phase: "requested",
            restarted: null,
          });

          const result = yield* shell.exec([
            "python3",
            "-c",
            restartScript,
            JSON.stringify(target),
            "restart",
            ...argv,
          ]);

          if (result.code === 75) {
            return yield* deferred(target, result.stdout);
          }

          const observed = yield* Schema.decodeEffect(
            Schema.fromJsonString(RestartResult)
          )(result.stdout).pipe(
            Effect.mapError(
              () =>
                new HostError({
                  operation: "ship",
                  reason: "Restart outcome unavailable",
                })
            )
          );

          yield* appendRestartEvent(target, {
            durationSeconds: observed.durationSeconds,
            phase: "completed",
            restarted: observed.restarted,
          });

          return { code: observed.code, stdout: "" };
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.mapError(
              () =>
                new HostError({
                  operation: "ship",
                  reason: "Guarded lifecycle command failed",
                })
            )
          )
      ),
    } satisfies Interface;
  }
);
