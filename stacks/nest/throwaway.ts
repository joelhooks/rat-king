import { Stack, localState } from "alchemy";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import * as Apply from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { deploy } from "alchemy/Deploy";
import { evalStack } from "alchemy/EvalStack";
import { onEvent } from "alchemy/Events";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import {
  Clock,
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Result,
  Schedule,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readIdentity } from "../../apps/mailbox/cli/identity.ts";
import { provision } from "../../apps/mailbox/cli/provision.ts";
import { traffic } from "../../apps/mailbox/cli/traffic.ts";
import { bindings } from "../../apps/mailbox/src/bindings.ts";
import { Celld } from "../../packages/alchemy-nest/src/celld.ts";
import { prepareDeployment } from "../../packages/alchemy-nest/src/deployment-build.ts";
import {
  deploymentStageLayout,
  stageDeploymentFiles,
} from "../../packages/alchemy-nest/src/deployment-stage.ts";
import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { HostShell, must } from "../../packages/alchemy-nest/src/host-shell.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import {
  Host,
  layer as inventoryLayer,
} from "../../packages/alchemy-nest/src/host.ts";
import { probeUnitLimits } from "../../packages/alchemy-nest/src/instance-probe-stack.ts";
import { startupLayer } from "../../packages/alchemy-nest/src/instance-startup-contract.ts";
import { validateInstance } from "../../packages/alchemy-nest/src/instance.ts";
import type { InstanceLayout } from "../../packages/alchemy-nest/src/instance.ts";
import type { Node } from "../../packages/alchemy-nest/src/inventory-schema.ts";
import { ObjectStore } from "../../packages/alchemy-nest/src/object-store.ts";
import { withDestroyReceipt } from "../../packages/alchemy-nest/src/probe-receipts.ts";
import { sourceLayer } from "../../packages/alchemy-nest/src/release.ts";
import { layer as shellLayer } from "../../packages/alchemy-nest/src/ssh.ts";
import * as Defs from "../../packages/lexicon/src/defs.ts";
import {
  layer as mailboxLayer,
  RatKingMailbox,
  transportLayer,
} from "../../packages/mailbox-client/src/index.ts";
import type { IdentityValue } from "../../packages/mailbox-client/src/index.ts";
import { repositoryEnvironment } from "./ship-judge.ts";
import { FleetError as ThrowawayError } from "./stage-config.ts";
import {
  portCount,
  throwawayTarget,
  throwawayUsage,
} from "./throwaway-target.ts";
import type { ThrowawayTarget } from "./throwaway-target.ts";

export const guardedUnits = [
  "rat-king-celld.service",
  "rat-king-seaweedfs.service",
  "mischief-celld.service",
  "mischief-seaweedfs.service",
] as const;

export const throwawayDids = (name: string) => ({
  alpha: `did:web:alpha.${name}.throwaway.invalid`,
  bravo: `did:web:bravo.${name}.throwaway.invalid`,
  charlie: `did:web:charlie.${name}.throwaway.invalid`,
  operator: `did:web:operator.${name}.throwaway.invalid`,
  service: `did:web:${name}.throwaway.invalid`,
});

const Pids = Schema.Record(Schema.String, Schema.Int);

const Baseline = Schema.Struct({
  dataRoot: Schema.String,
  home: Schema.String,
  name: Schema.String,
  node: Schema.String,
  pids: Pids,
  portBase: Schema.Int,
});

const guardedPidScript = String.raw`
import json, subprocess, sys
result = {}
for unit in sys.argv[1:]:
    text = subprocess.run(['systemctl', '--user', 'show', unit, '--property=ActiveState,MainPID'], check=True, capture_output=True, text=True).stdout
    fields = dict(line.split('=', 1) for line in text.splitlines())
    if fields.get('ActiveState') != 'active' or int(fields.get('MainPID', '0')) <= 0:
        raise ValueError('guarded unit inactive')
    result[unit] = int(fields['MainPID'])
print(json.dumps(result))
`;

const loopbackScript = String.raw`
import json, subprocess, sys
first, last = int(sys.argv[1]), int(sys.argv[2])
rows = subprocess.run(['ss', '-H', '-ltn'], check=True, capture_output=True, text=True).stdout.splitlines()
binds = {}
for row in rows:
    local = row.split()[3]
    address, port = local.rsplit(':', 1)
    if first <= int(port) <= last:
        binds.setdefault(int(port), []).append(address)
print(json.dumps({'loopback': sum(1 for port in range(first, last + 1) if binds.get(port) == ['127.0.0.1']), 'open': len(binds), 'exposed': sum(1 for addresses in binds.values() if addresses != ['127.0.0.1'])}))
`;

export const throwawayGoneScript = String.raw`
import glob, json, os, re, subprocess, sys
home, data, name, first, last, s3, grpc, before = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), sys.argv[6], sys.argv[7], json.loads(sys.argv[8])
failed = False
def check(label, clean):
    global failed
    print(('PASS ' if clean else 'FAIL ') + label)
    failed |= not clean
def command(*args):
    result = subprocess.run(args, check=False, text=True, capture_output=True)
    if result.returncode == 1 and args[:3] == ('systemctl', '--user', 'list-unit-files') and not result.stdout.strip():
        return result.stdout
    result.check_returncode()
    return result.stdout
try:
    files = command('systemctl', '--user', 'list-unit-files', name + '-*', '--no-legend', '--no-pager')
    loaded = command('systemctl', '--user', 'list-units', '--all', name + '-*', name + '.slice', '--no-legend', '--no-pager')
    slices = command('systemctl', '--user', 'list-unit-files', name + '.slice', '--no-legend', '--no-pager')
    check('instance units absent', not files.strip() and not loaded.strip() and not slices.strip() and not glob.glob(home + '/.config/systemd/user/' + name + '*'))
    check('wants links absent', not glob.glob(home + '/.config/systemd/user/*.wants/' + name + '*'))
    listeners = command('ss', '-H', '-ltn')
    ports = {int(match.group(1)) for row in listeners.splitlines() if (match := re.search(r':(\d+)$', row.split()[3]))}
    check('ports %d-%d closed' % (first, last), ports.isdisjoint(range(first, last + 1)))
    for label, path in [('configuration and staging absent', home + '/.config/' + name), ('binary root absent', home + '/.local/share/' + name), ('data root absent', data), ('S3 socket absent', '/tmp/seaweedfs-s3-' + s3 + '.sock'), ('S3 gRPC socket absent', '/tmp/seaweedfs-s3-grpc-' + grpc + '.sock')]:
        check(label, not os.path.lexists(path))
    for unit, pid in before.items():
        fields = dict(line.split('=', 1) for line in command('systemctl', '--user', 'show', unit, '--property=ActiveState,MainPID').splitlines())
        check(unit + ' active with unchanged MainPID', fields.get('ActiveState') == 'active' and int(fields.get('MainPID', '0')) == pid and pid > 0)
except (OSError, ValueError, IndexError, subprocess.CalledProcessError):
    check('probe commands completed', False)
sys.exit(1 if failed else 0)
`;

const curl = (url: string) => [
  "curl",
  "--fail",
  "--silent",
  "--show-error",
  "--max-time",
  "10",
  url,
];

export const throwawayProgram = (
  host: Node,
  target: ThrowawayTarget,
  prepared: {
    readonly bundle: string;
    readonly commit: string;
    readonly configuration: string;
    readonly version: string;
  }
) =>
  Effect.gen(function* throwawayStack() {
    const slice = yield* ObjectStore.Slice({
      ...probeUnitLimits.slice,
      home: host.home,
      instance: target.name,
    });

    const bucket = yield* ObjectStore.Bucket("store", {
      ...probeUnitLimits.seaweed,
      dataRoot: target.dataRoot,
      host: { ...host, tailnetIPv4: "127.0.0.1" },
      instance: target.name,
      legacyRandomCredentials: true,
      name: `${target.name}-cells`,
      portBase: target.portBase,
      purgeOnDelete: true,
      slice: slice.sha256,
    });

    const staged = yield* stageDeploymentFiles(
      host.home,
      prepared,
      true,
      bucket.layout,
      bucket.configuration
    );

    const node = yield* Celld.Node("celld", {
      ...probeUnitLimits.celld,
      bucket,
      host: { ...host, tailnetIPv4: "127.0.0.1" },
      instance: target.name,
      portBase: target.portBase,
      prepared: staged,
      purgeOnDelete: true,
    });

    return yield* Celld.Deployment("worker", {
      ...prepared,
      binary: `${bucket.layout.bin}/celld`,
      directory: deploymentStageLayout(host.home, bucket.layout).directory,
      environmentFile: `${bucket.layout.configuration}/celld.env`,
      internalUrl: node.internalUrl,
      workerUrl: node.publicUrl,
    });
  });

const agents = ["operator", "alpha", "bravo", "charlie"] as const;

const identities = Effect.fn("Throwaway.identities")(function* identities(
  target: ThrowawayTarget
) {
  const path = yield* Path.Path;
  const home = path.join(target.state, "home");
  const dids = throwawayDids(target.name);
  const minted: unknown[] = [];

  for (const agent of agents) {
    minted.push(yield* provision(home, agent, dids[agent]));
  }

  const documents = yield* Schema.decodeUnknownEffect(
    Schema.Array(Defs.DidDocument)
  )(minted);

  return { dids, documents, home };
});

const client = (
  target: ThrowawayTarget,
  identity: IdentityValue,
  documents: readonly Defs.DidDocumentValue[]
) =>
  mailboxLayer({
    documents,
    endpoint: `http://127.0.0.1:${target.portBase}`,
    identity,
    serviceDid: throwawayDids(target.name).service,
  }).pipe(Layer.provide(FetchHttpClient.layer));

const repositoryCommit = Effect.gen(function* repositoryCommit() {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const commit = yield* spawner.string(
    ChildProcess.make(
      "git",
      ["-C", path.resolve(import.meta.dirname, "../.."), "rev-parse", "HEAD"],
      {
        env: repositoryEnvironment(process.env),
        extendEnv: false,
        stdin: "ignore",
      }
    )
  );

  return commit.trim();
});

const remoteHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* remoteHttp() {
    const shell = yield* HostShell;

    return HttpClient.make((request) =>
      must(shell, curl(request.url)).pipe(
        Effect.map((body) =>
          HttpClientResponse.fromWeb(request, new Response(body))
        ),
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ cause, request }),
            })
        )
      )
    );
  })
);

const guardedPids = (shell: Interface) =>
  must(shell, ["python3", "-c", guardedPidScript, ...guardedUnits]).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Pids)))
  );

export const listenerHealth = Effect.fn("Throwaway.listenerHealth")(
  function* listenerHealth(shell: Interface, layout: InstanceLayout) {
    const listeners = yield* must(shell, [
      "python3",
      "-c",
      loopbackScript,
      `${layout.portBase}`,
      `${layout.portBase + portCount - 1}`,
    ]).pipe(
      Effect.flatMap(
        Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              exposed: Schema.Int,
              loopback: Schema.Int,
              open: Schema.Int,
            })
          )
        )
      )
    );

    const healthy = yield* must(
      shell,
      curl(`http://127.0.0.1:${layout.portBase}/.well-known/celld/health`)
    ).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    );

    return {
      listeners: { count: listeners.loopback, expected: portCount },
      status:
        healthy && listeners.exposed === 0 && listeners.loopback === portCount
          ? ("ok" as const)
          : ("fail" as const),
    };
  }
);

export const runThrowaway = Effect.fn("Throwaway.run")(function* runThrowaway(
  action:
    | "plan"
    | "up"
    | "health"
    | "drive"
    | "traffic"
    | "destroy-plan"
    | "down"
    | "verify-gone",
  target: ThrowawayTarget,
  options: {
    readonly count: number;
    readonly intervalMs: number;
    readonly out: string | undefined;
    readonly plant: string | undefined;
  }
) {
  const alias = yield* Config.String("RAT_KING_LIVE_NODE");
  const host = yield* (yield* Host).node(alias);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const layout = yield* validateInstance(host, {
    dataRoot: target.dataRoot,
    instance: target.name,
    portBase: target.portBase,
  });

  const connection = shellLayer(
    host,
    {
      dataRoot: target.dataRoot,
      instance: target.name,
      portBase: target.portBase,
    },
    { transport: "local" }
  );

  const baselineFile = path.join(target.state, "baseline.json");

  const readBaseline = Effect.gen(function* readBaseline() {
    const saved = yield* Schema.decodeEffect(Schema.fromJsonString(Baseline))(
      yield* fs.readFileString(baselineFile)
    );

    if (
      saved.home !== host.home ||
      saved.dataRoot !== target.dataRoot ||
      saved.node !== alias ||
      saved.name !== target.name ||
      saved.portBase !== target.portBase
    ) {
      return yield* refuse("Baseline belongs to another throwaway instance.");
    }

    return saved;
  });

  const unchangedPids = Effect.gen(function* unchangedPids() {
    const saved = yield* readBaseline;
    const now = yield* guardedPids(yield* HostShell);

    if (JSON.stringify(saved.pids) !== JSON.stringify(now)) {
      return yield* refuse("Guarded MainPIDs changed since the baseline.");
    }

    return saved;
  });

  const { dids, documents, home } = yield* identities(target);

  const vars = Object.fromEntries([
    ["DID_DOCUMENTS", JSON.stringify(documents)],
    ["LEASE_RESOLVERS", "[]"],
    ["OBSERVER_DIDS", "[]"],
    ["OPERATOR_DIDS", JSON.stringify([dids.operator])],
    ["SERVICE_DID", dids.service],
    ...(options.plant === undefined
      ? []
      : [["SHIP_WATCH_PLANT", options.plant] as const]),
  ]);

  const commit = yield* repositoryCommit;

  const prepared = yield* prepareDeployment(
    path.resolve(import.meta.dirname, "../../apps/mailbox/src/worker.ts"),
    bindings,
    { commit, vars, version: `throwaway-${commit.slice(0, 12)}` }
  );

  const providers = Layer.mergeAll(
    ObjectStore.providers(),
    Celld.providers(),
    Celld.deploymentProvider()
  ).pipe(
    Layer.provide(
      startupLayer("127.0.0.1", "scope", undefined, undefined, layout)
    ),
    Layer.provide(remoteHttp),
    Layer.provideMerge(connection),
    Layer.provide(sourceLayer.pipe(Layer.provide(FetchHttpClient.layer)))
  );

  const stack = Stack(
    `rat-king-throwaway-${target.name}`,
    { providers: providers.pipe(Layer.orDie), state: localState() },
    throwawayProgram(host, target, prepared).pipe(Effect.orDie)
  );

  if (action === "plan" || action === "destroy-plan") {
    const summary = yield* evalStack(
      stack,
      (compiled) =>
        action === "plan"
          ? Plan.make(compiled).pipe(Effect.map(Plan.describePlan))
          : Plan.destroy(compiled).pipe(Effect.map(Plan.describePlan)),
      { stage: "throwaway" }
    );

    return yield* Console.log(JSON.stringify(summary));
  }

  const live = Effect.gen(function* live() {
    const shell = yield* HostShell;

    if (action === "up") {
      if (
        !(yield* Config.Boolean("RAT_KING_START_APPROVED").pipe(
          Config.withDefault(false)
        ))
      ) {
        return yield* refuse(
          "Throwaway up needs RAT_KING_START_APPROVED=true."
        );
      }

      if (yield* fs.exists(baselineFile)) {
        yield* unchangedPids;
      } else {
        for (const owned of [
          layout.configuration,
          layout.binaryRoot,
          layout.dataRoot,
        ]) {
          if ((yield* shell.stat(owned)) !== undefined) {
            return yield* refuse(
              "Throwaway directories must be absent before first up."
            );
          }
        }

        const health = yield* listenerHealth(shell, layout);

        if (health.listeners.count > 0) {
          return yield* refuse("Throwaway ports must be free before first up.");
        }

        yield* fs.writeFileString(
          baselineFile,
          JSON.stringify({
            dataRoot: target.dataRoot,
            home: host.home,
            name: target.name,
            node: alias,
            pids: yield* guardedPids(shell),
            portBase: target.portBase,
          }),
          { flag: "wx", mode: 0o600 }
        );
      }

      yield* deploy({ stack, stage: "throwaway" });
      yield* unchangedPids;

      return yield* Console.log(
        JSON.stringify({
          commit,
          deployedAt: DateTime.formatIso(
            DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
          ),
          name: target.name,
          plant: options.plant ?? null,
          ...(yield* listenerHealth(shell, layout)),
        })
      );
    }

    if (action === "health") {
      return yield* Console.log(
        JSON.stringify(yield* listenerHealth(shell, layout))
      );
    }

    if (action === "verify-gone") {
      const saved = yield* readBaseline;

      const result = yield* shell
        .exec([
          "python3",
          "-c",
          throwawayGoneScript,
          host.home,
          target.dataRoot,
          target.name,
          `${target.portBase}`,
          `${target.portBase + portCount - 1}`,
          `${layout.ports.s3}`,
          `${layout.ports.s3Grpc}`,
          JSON.stringify(saved.pids),
        ])
        .pipe(
          Effect.catchTag("HostError", () =>
            Effect.succeed({ code: 1, stdout: "FAIL probe execution" })
          )
        );

      yield* Console.log(result.stdout.trimEnd());

      if (result.code !== 0) {
        return yield* refuse("Throwaway teardown left debris.");
      }

      return yield* Effect.void;
    }

    if (action === "down") {
      if (
        !(yield* Config.Boolean("RAT_KING_DESTROY_APPROVED").pipe(
          Config.withDefault(false)
        ))
      ) {
        return yield* refuse(
          "Throwaway down needs RAT_KING_DESTROY_APPROVED=true after destroy-plan."
        );
      }

      yield* readBaseline;

      yield* evalStack(
        stack,
        (compiled) =>
          Plan.destroy(compiled).pipe(
            Effect.flatMap((plan) =>
              withDestroyReceipt(Object.keys(plan.deletions), (session) =>
                Apply.apply(plan).pipe(
                  onEvent((event) =>
                    event.type === "apply.resource.status" ||
                    event.type === "apply.resource.note"
                      ? session.emit(event)
                      : Effect.void
                  )
                )
              )
            )
          ),
        { stage: "throwaway" }
      );

      return yield* Console.log("THROWAWAY_DESTROYED_RUN_VERIFY_GONE");
    }

    return yield* Effect.void;
  }).pipe(Effect.provide(connection));

  if (action === "drive") {
    const alpha = yield* readIdentity(home, "alpha");
    const sessionId = `throwaway-${yield* Clock.currentTimeMillis}`;

    const leaseFor = (
      recipient: { did: string; identity: IdentityValue },
      held?: { generation: number; leaseId: string }
    ) =>
      Effect.gen(function* acquireLease() {
        const now = yield* Clock.currentTimeMillis;

        return yield* (yield* RatKingMailbox).lease.acquire({
          did: recipient.did,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 240_000)),
          harness: {
            $type: "sh.mschf.ratking.runtime.lease#pi",
            sessionId,
          },
          ...held,
        });
      }).pipe(Effect.provide(client(target, recipient.identity, documents)));

    const recipientFor = (agent: "bravo" | "charlie") =>
      Effect.gen(function* recipient() {
        const identity = yield* readIdentity(home, agent);
        const did = dids[agent];

        const lease = yield* leaseFor({ did, identity }).pipe(
          Effect.retry(
            Schedule.spaced("5 seconds").pipe(Schedule.upTo({ times: 60 }))
          )
        );

        return {
          did,
          identity,
          session: { lease, leasedAt: yield* Clock.currentTimeMillis },
        };
      });

    const bravo = yield* recipientFor("bravo");
    const charlie = yield* recipientFor("charlie");
    const recipientAt = (index: number) => (index % 2 === 0 ? bravo : charlie);

    const tally = { acked: 0, failed: 0, sent: 0 };

    const step = (index: number) =>
      Effect.gen(function* exchange() {
        const recipient = recipientAt(index);
        const { session } = recipient;

        if ((yield* Clock.currentTimeMillis) - session.leasedAt > 120_000) {
          session.lease = yield* leaseFor(recipient, {
            generation: session.lease.generation,
            leaseId: session.lease.leaseId,
          });
          session.leasedAt = yield* Clock.currentTimeMillis;
        }

        const sent = yield* Effect.gen(function* send() {
          return yield* (yield* RatKingMailbox).send(
            recipient.did,
            `throwaway ${index}`
          );
        }).pipe(Effect.provide(client(target, alpha, documents)));

        tally.sent += 1;

        const fenced = {
          generation: session.lease.generation,
          leaseId: session.lease.leaseId,
          message: sent.receipt.message,
        };

        yield* Effect.gen(function* receive() {
          const mailbox = yield* RatKingMailbox;
          yield* mailbox.deliver(fenced);
          yield* mailbox.ack(fenced);
        }).pipe(Effect.provide(client(target, recipient.identity, documents)));

        tally.acked += 1;
      });

    yield* Effect.forEach(
      Array.from({ length: options.count }, (_, index) => index),
      (index) =>
        Effect.gen(function* paced() {
          const outcome = yield* Effect.result(step(index));

          if (Result.isFailure(outcome)) {
            tally.failed += 1;
            recipientAt(index).session.leasedAt = 0;
          }

          yield* Effect.sleep(Duration.millis(options.intervalMs));
        }),
      { discard: true }
    );

    return yield* Console.log(JSON.stringify(tally));
  }

  if (action === "traffic") {
    const operator = yield* readIdentity(home, "operator");
    const lines: string[] = [];

    yield* traffic({ cursor: "0", follow: false }).pipe(
      Effect.provide(
        transportLayer(
          `http://127.0.0.1:${target.portBase}`,
          `${dids.service}#mailbox`,
          operator
        ).pipe(Layer.provide(FetchHttpClient.layer))
      ),
      Effect.provideService(Console.Console, {
        ...console,
        log: (...values: readonly unknown[]) => {
          lines.push(values.join(" "));
        },
      })
    );

    if (options.out === undefined) {
      return yield* refuse("Traffic export needs --out <file>.");
    }

    yield* fs.writeFileString(options.out, `${lines.join("\n")}\n`, {
      mode: 0o600,
    });

    return yield* Console.log(
      JSON.stringify({ events: lines.length, out: options.out })
    );
  }

  return yield* live;
});

const ThrowawayAction = Schema.Literals([
  "plan",
  "up",
  "health",
  "drive",
  "traffic",
  "destroy-plan",
  "down",
  "verify-gone",
]);

const flagNames = new Set([
  "--state",
  "--name",
  "--ports",
  "--data-root",
  "--plant",
  "--count",
  "--interval-ms",
  "--out",
]);

export const throwawayCommand = Effect.fn("Throwaway.command")(
  function* throwawayCommand(args: readonly string[]) {
    const [first, ...rest] = args;

    const action = yield* Schema.decodeUnknownEffect(ThrowawayAction)(
      first
    ).pipe(
      Effect.mapError(() => new ThrowawayError({ reason: throwawayUsage }))
    );

    const flags = new Map<string, string>();

    for (let index = 0; index < rest.length; index += 2) {
      const flag = rest[index];
      const value = rest[index + 1];

      if (
        flag === undefined ||
        value === undefined ||
        !flagNames.has(flag) ||
        value.startsWith("--") ||
        flags.has(flag)
      ) {
        return yield* new ThrowawayError({ reason: throwawayUsage });
      }

      flags.set(flag, value);
    }

    const target = yield* throwawayTarget(flags);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(target.state, { mode: 0o700, recursive: true });
    yield* fs.chmod(target.state, 0o700);
    process.chdir(yield* fs.realPath(target.state));

    return yield* runThrowaway(action, target, {
      count: Number(flags.get("--count") ?? "30"),
      intervalMs: Number(flags.get("--interval-ms") ?? "5000"),
      out: flags.get("--out"),
      plant: flags.get("--plant"),
    }).pipe(
      provideFreshArtifactStore,
      Effect.provide(
        Layer.mergeAll(
          inventoryLayer,
          AlchemyContextLive,
          localState(),
          layerNonInteractive()
        )
      )
    );
  }
);
