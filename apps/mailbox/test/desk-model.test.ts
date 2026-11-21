// @effect-diagnostics asyncFunction:off -- fast-check async commands drive the real desk route over node SQLite.
import { it } from "@effect/vitest";
import * as Ack from "@rat-king/lexicon/desk.ack";
import * as BindProject from "@rat-king/lexicon/desk.bindProject";
import * as Fork from "@rat-king/lexicon/desk.fork";
import * as Inbox from "@rat-king/lexicon/desk.inbox";
import * as Ingest from "@rat-king/lexicon/desk.ingest";
import * as Pending from "@rat-king/lexicon/desk.pending";
import * as RememberReply from "@rat-king/lexicon/desk.rememberReply";
import * as ReplyFor from "@rat-king/lexicon/desk.replyFor";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { ownerCid } from "@rat-king/mailbox-client/owner-queue";
import { Arbitrary, DateTime, Effect, Layer, Schema } from "effect";
import * as fc from "fast-check";
import { expect } from "vitest";

import { Caller } from "../src/caller.ts";
import { DeskSnapshot, DeskStore, deskStore } from "../src/desk-store.ts";
import type { DeskSnapshotValue } from "../src/desk-store.ts";
import { DeskRegistry, deskHandlers, deskRoute } from "../src/desk.ts";
import type { Sql } from "../src/sqlite.ts";
import { TestFailure } from "./celld.ts";
import { testStoreFor } from "./helpers.ts";

const desks = [0, 1, 2, 3, 4].map(
  (index) => `did:web:desk-${index}.example.invalid`
);

const authors = ["a", "b", "c"].map(
  (name) => `did:web:agent-${name}.example.invalid`
);

const stranger = "did:web:stranger.example.invalid";

const [first = stranger, second = stranger, third = stranger] = desks;

const projects = ["alpha", "beta"];

const kinds = [
  "fyi",
  "progress",
  "done",
  "question",
  "blocked",
  "action",
] as const;

type Invariant =
  | "noLoss"
  | "noDoubleDelivery"
  | "cursorMonotonic"
  | "forkInheritsCursor"
  | "dedupe"
  | "authorization"
  | "project"
  | "replies";

interface Content {
  readonly author: string;
  readonly createdAt: string;
  readonly kind: string;
  readonly text: string;
  readonly uri: string;
  readonly project?: string;
  readonly facets?: readonly {
    readonly features: readonly {
      readonly $type: string;
      readonly did: string;
    }[];
    readonly index: { readonly byteEnd: number; readonly byteStart: number };
  }[];
}

interface Held {
  readonly seq: number;
  readonly uri: string;
  readonly item: Content;
}

interface DeskModel {
  head: number;
  deliveredThrough: number;
  items: Held[];
  delivered: Set<string>;
  project?: string | undefined;
  replies: Map<string, string>;
  forked: boolean;
  observedThrough: number;
}

interface Model {
  readonly desks: Map<string, DeskModel>;
  clock: number;
  serial: number;
}

interface Real {
  readonly invariant: Invariant;
  readonly call: (
    desk: string,
    caller: string,
    request: XrpcRequest
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly restart: (desk: string) => void;
  readonly cid: (content: Content) => Promise<string>;
}

const emptyDesk = (): DeskModel => ({
  delivered: new Set(),
  deliveredThrough: 0,
  forked: false,
  head: 0,
  items: [],
  observedThrough: 0,
  replies: new Map(),
});

const deskOf = (model: Model, desk: string) => {
  const found = model.desks.get(desk) ?? emptyDesk();
  model.desks.set(desk, found);

  return found;
};

const undelivered = (desk: DeskModel) =>
  desk.items.filter(
    (held) => held.seq > desk.deliveredThrough && !desk.delivered.has(held.uri)
  );

const compact = (desk: DeskModel) => {
  for (const held of desk.items.filter(
    (entry) => entry.seq > desk.deliveredThrough
  )) {
    if (!desk.delivered.has(held.uri)) {
      return;
    }

    desk.deliveredThrough = held.seq;
  }
};

const post = (nsid: string, input: Schema.JsonObject): XrpcRequest => ({
  input,
  method: "POST",
  nsid,
  params: undefined,
});

const get = (nsid: string, params: Record<string, string | number>) => ({
  input: undefined,
  method: "GET" as const,
  nsid,
  params,
});

const errorOf = (body: string) =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
  )(body).error;

const decoded = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  response: { readonly status: number; readonly body: string }
): S["Type"] => {
  expect(response.status, response.body).toBe(200);

  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(response.body);
};

const iso = (seconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(1_791_676_800_000 + seconds * 1000));

const readInbox = async (real: Real, desk: string, since?: string) =>
  decoded(
    Inbox.Output,
    await real.call(
      desk,
      desk,
      get(
        Inbox.Method.nsid,
        since === undefined ? { desk, limit: 200 } : { desk, limit: 200, since }
      )
    )
  );

interface Observed {
  readonly real: Real;
  readonly did: string;
  readonly desk: DeskModel;
  readonly open: typeof Inbox.Output.Type;
}

const openUris = (observed: Observed) =>
  observed.open.items.map((entry) => entry.item.uri);

const unchecked = async () => {
  await Promise.resolve();
};

const checks: Record<Invariant, (observed: Observed) => Promise<void>> = {
  authorization: unchecked,
  cursorMonotonic: async ({ desk, open }) => {
    await Promise.resolve();
    expect(open.deliveredThrough).toBeGreaterThanOrEqual(desk.observedThrough);
    desk.observedThrough = open.deliveredThrough;
  },
  dedupe: unchecked,
  forkInheritsCursor: async (observed) => {
    await Promise.resolve();

    if (observed.desk.forked) {
      expect(openUris(observed)).toEqual(
        undelivered(observed.desk).map((held) => held.uri)
      );
      expect(observed.open.deliveredThrough).toBe(
        observed.desk.deliveredThrough
      );
    }
  },
  noDoubleDelivery: async (observed) => {
    const { real, did, desk } = observed;

    const view = decoded(
      Pending.Output,
      await real.call(did, did, get(Pending.Method.nsid, { desk: did }))
    );

    for (const uri of [...openUris(observed), ...view.covered]) {
      expect(desk.delivered.has(uri)).toBe(false);
    }
  },
  noLoss: async (observed) => {
    const { real, did, desk } = observed;
    const all = await readInbox(real, did, iso(0));

    expect(all.items.map((entry) => entry.item.uri)).toEqual(
      desk.items.map((held) => held.uri)
    );
    expect(openUris(observed)).toEqual(
      expect.arrayContaining(undelivered(desk).map((held) => held.uri))
    );
  },
  project: unchecked,
  replies: async ({ real, did, desk }) => {
    const replies = await Promise.all(
      desk.items.map(
        async (held) =>
          await real.call(
            did,
            did,
            get(ReplyFor.Method.nsid, { desk: did, uri: held.uri })
          )
      )
    );

    expect(
      replies.map((reply) => decoded(ReplyFor.Output, reply).messageId)
    ).toEqual(desk.items.map((held) => desk.replies.get(held.uri)));
  },
};

const checkDesk = async (real: Real, did: string, desk: DeskModel) => {
  const open = await readInbox(real, did);

  await checks[real.invariant]({ desk, did, open, real });
};

const checkModel = async (model: Model, real: Real) => {
  await Promise.all(
    [...model.desks].map(async ([did, desk]) => {
      await checkDesk(real, did, desk);
    })
  );
};

const command = (
  name: string,
  run: (model: Model, real: Real) => Promise<void>
): fc.AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (model, real) => {
    await run(model, real);
    await checkModel(model, real);
  },
  toString: () => name,
});

const content = (
  model: Model,
  spec: {
    readonly author: string;
    readonly desk: string;
    readonly kind: (typeof kinds)[number];
    readonly mention: boolean;
    readonly project?: string | undefined;
  }
) => {
  model.serial += 1;
  model.clock += 1;

  const prefix = spec.mention ? `@${spec.desk} ` : "";
  const text = `${prefix}note ${model.serial}\nbody ✓ ${model.serial}`;

  let item: Content = {
    author: spec.author,
    createdAt: iso(model.clock),
    kind: spec.kind,
    text,
    uri: `muster://${spec.author}/note/${model.serial}`,
  };

  if (spec.mention) {
    const facets = [
      {
        features: [
          { $type: "sh.mschf.ratking.desk.defs#mention", did: spec.desk },
        ],
        index: {
          byteEnd: new TextEncoder().encode(prefix.trimEnd()).length,
          byteStart: 0,
        },
      },
    ];

    item = { ...item, facets };
  }

  if (spec.project !== undefined) {
    item = { ...item, project: spec.project };
  }

  return item;
};

const ingest = async (
  real: Real,
  desk: string,
  caller: string,
  item: Content
) =>
  await real.call(
    desk,
    caller,
    post(Ingest.Method.nsid, {
      desk,
      item: { ...item, cid: await real.cid(item) },
    })
  );

const postCommand = (spec: {
  readonly author: string;
  readonly desk: string;
  readonly kind: (typeof kinds)[number];
  readonly mention: boolean;
  readonly selfPost: boolean;
  readonly project: number;
}) =>
  command(`post(${JSON.stringify(spec)})`, async (model, real) => {
    const desk = deskOf(model, spec.desk);
    const project = projects[spec.project];
    const item = content(model, { ...spec, project });
    const caller = spec.selfPost ? spec.desk : spec.author;
    const response = await ingest(real, spec.desk, caller, item);

    if (
      desk.project !== undefined &&
      project !== undefined &&
      project !== desk.project
    ) {
      if (real.invariant === "project") {
        expect(errorOf(response.body)).toBe("ProjectMismatch");
      }

      return;
    }

    desk.head += 1;
    desk.items.push({ item, seq: desk.head, uri: item.uri });

    if (real.invariant === "dedupe") {
      expect(decoded(Ingest.Output, response)).toEqual({
        seq: desk.head,
        stored: true,
      });
    }
  });

const pick = <A>(values: readonly A[], index: number) =>
  values.length === 0 ? undefined : values[index % values.length];

const reingestCommand = (desk: string, index: number, tamper: boolean) =>
  command(
    `${tamper ? "tamper" : "reingest"}(${desk}, ${index})`,
    async (model, real) => {
      const held = pick(deskOf(model, desk).items, index);

      if (held === undefined) {
        return;
      }

      const item = tamper
        ? { ...held.item, text: `${held.item.text} (edited)` }
        : held.item;

      const response = await ingest(real, desk, desk, item);

      if (real.invariant === "dedupe") {
        if (tamper) {
          expect(errorOf(response.body)).toBe("CidConflict");
        } else {
          expect(decoded(Ingest.Output, response)).toEqual({
            seq: held.seq,
            stored: false,
          });
        }
      }
    }
  );

const ackCommand = (desk: string, indices: readonly number[], stray: boolean) =>
  command(
    `ack(${desk}, ${JSON.stringify(indices)}, ${stray})`,
    async (model, real) => {
      const target = deskOf(model, desk);

      const uris = [
        ...indices.flatMap((index) => {
          const held = pick(target.items, index);

          return held === undefined ? [] : [held.uri];
        }),
        ...(stray ? ["muster://nobody/note/0"] : []),
      ];

      if (uris.length === 0) {
        return;
      }

      const fresh = new Set(
        uris.filter((uri) =>
          undelivered(target).some((held) => held.uri === uri)
        )
      );

      const response = await real.call(
        desk,
        desk,
        post(Ack.Method.nsid, { desk, uris })
      );

      for (const uri of fresh) {
        target.delivered.add(uri);
      }

      compact(target);

      if (real.invariant === "noDoubleDelivery") {
        expect(decoded(Ack.Output, response).acked).toBe(fresh.size);
      }
    }
  );

const wakeCommand = (desk: string) =>
  command(`wake(${desk})`, async (model, real) => {
    const target = deskOf(model, desk);

    const view = decoded(
      Pending.Output,
      await real.call(desk, desk, get(Pending.Method.nsid, { desk }))
    );

    if (view.covered.length === 0) {
      return;
    }

    if (real.invariant === "noLoss") {
      expect(view.covered).toEqual(undelivered(target).map((held) => held.uri));
    }

    await real.call(
      desk,
      desk,
      post(Ack.Method.nsid, { desk, uris: view.covered })
    );

    for (const uri of view.covered) {
      target.delivered.add(uri);
    }

    compact(target);
  });

const restartCommand = (desk: string) =>
  command(`restart(${desk})`, async (_model, real) => {
    await Promise.resolve();
    real.restart(desk);
  });

const forkCommand = (from: string, to: string, fraction: number) =>
  command(`fork(${from} -> ${to}, ${fraction})`, async (model, real) => {
    const source = deskOf(model, from);
    const target = deskOf(model, to);
    const atSeq = Math.floor(source.head * fraction);

    const response = await real.call(
      to,
      from,
      post(Fork.Method.nsid, { atSeq, desk: to, fromDid: from })
    );

    if (from === to) {
      return;
    }

    if (from !== third && (from !== first || to !== second)) {
      if (real.invariant === "authorization") {
        expect(errorOf(response.body)).toBe("Forbidden");
      }

      return;
    }

    const empty =
      target.head === 0 &&
      target.project === undefined &&
      target.replies.size === 0;

    if (!empty) {
      if (real.invariant === "forkInheritsCursor") {
        expect(errorOf(response.body)).toBe("DeskNotEmpty");
      }

      return;
    }

    const items = source.items.filter((held) => held.seq <= atSeq);

    target.items = [...items];
    target.head = atSeq;
    target.deliveredThrough = Math.min(source.deliveredThrough, atSeq);
    target.delivered = new Set(
      items
        .filter((held) => source.delivered.has(held.uri))
        .map((held) => held.uri)
    );
    target.project = source.project;
    target.replies = new Map(
      [...source.replies].filter(([uri]) =>
        items.some((held) => held.uri === uri)
      )
    );
    target.forked = true;

    if (
      real.invariant === "forkInheritsCursor" ||
      real.invariant === "authorization"
    ) {
      expect(decoded(Fork.Output, response)).toEqual({
        atSeq,
        copied: items.length,
        deliveredThrough: target.deliveredThrough,
        desk: to,
        fromDid: from,
      });
    }
  });

const intruderCommand = (desk: string, author: string, kind: number) =>
  command(`intrude(${desk}, ${author}, ${kind})`, async (model, real) => {
    const caller = author;
    const target = deskOf(model, desk);
    const elsewhere = desks.find((other) => other !== desk) ?? stranger;

    const attempts = [
      get(Inbox.Method.nsid, { desk }),
      get(Pending.Method.nsid, { desk }),
      post(Ack.Method.nsid, {
        desk,
        uris: [...target.items.map((held) => held.uri).slice(0, 3), "x"],
      }),
      post(Fork.Method.nsid, { atSeq: 0, desk: elsewhere, fromDid: desk }),
      post(BindProject.Method.nsid, { desk, project: "intruded" }),
      post(RememberReply.Method.nsid, { desk, messageId: "3m5x", uri: "x" }),
    ];

    const attempt = attempts[kind % attempts.length];

    const forged = content(model, {
      author: authors.find((other) => other !== caller) ?? stranger,
      desk,
      kind: "fyi",
      mention: false,
    });

    const responses = [
      attempt === undefined
        ? undefined
        : await real.call(
            attempt.nsid === Fork.Method.nsid ? elsewhere : desk,
            caller,
            attempt
          ),
      await ingest(real, desk, caller, forged),
    ];

    if (real.invariant === "authorization") {
      for (const response of responses) {
        if (response !== undefined) {
          expect(errorOf(response.body)).toBe("Forbidden");
        }
      }
    }
  });

const bindCommand = (desk: string, project: number) =>
  command(`bind(${desk}, ${project})`, async (model, real) => {
    const target = deskOf(model, desk);
    const name = projects[project % projects.length] ?? "alpha";

    const response = await real.call(
      desk,
      desk,
      post(BindProject.Method.nsid, { desk, project: name })
    );

    if (target.project === undefined || target.project === name) {
      target.project = name;

      if (real.invariant === "project") {
        expect(decoded(BindProject.Output, response).project).toBe(name);
      }
    } else if (real.invariant === "project") {
      expect(errorOf(response.body)).toBe("ProjectConflict");
    }
  });

const rememberCommand = (desk: string, index: number, id: number) =>
  command(`remember(${desk}, ${index}, ${id})`, async (model, real) => {
    const target = deskOf(model, desk);
    const held = pick(target.items, index);

    if (held === undefined) {
      return;
    }

    const messageId = `3m5msg${id}`;

    await real.call(
      desk,
      desk,
      post(RememberReply.Method.nsid, { desk, messageId, uri: held.uri })
    );

    if (!target.replies.has(held.uri)) {
      target.replies.set(held.uri, messageId);
    }
  });

const Index = (size: number) =>
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(size - 1)
  );

const Small = Index(64);

const Spec = Schema.Union([
  Schema.Struct({
    author: Index(authors.length),
    desk: Index(desks.length),
    kind: Index(kinds.length),
    mention: Schema.Boolean,
    op: Schema.Literal("post"),
    project: Index(projects.length + 1),
    selfPost: Schema.Boolean,
  }),
  Schema.Struct({
    desk: Index(desks.length),
    index: Small,
    op: Schema.Literal("reingest"),
  }),
  Schema.Struct({
    desk: Index(desks.length),
    index: Small,
    op: Schema.Literal("tamper"),
  }),
  Schema.Struct({
    desk: Index(desks.length),
    indices: Schema.Array(Small).check(Schema.isMaxLength(4)),
    op: Schema.Literal("ack"),
    stray: Schema.Boolean,
  }),
  Schema.Struct({
    desk: Index(desks.length),
    op: Schema.Literal("wake"),
  }),
  Schema.Struct({
    desk: Index(desks.length),
    op: Schema.Literal("restart"),
  }),
  Schema.Struct({
    fraction: Schema.Literals([0, 0.25, 0.5, 0.75, 1]),
    from: Index(desks.length),
    op: Schema.Literal("fork"),
    to: Index(desks.length),
  }),
  Schema.Struct({
    author: Index(authors.length),
    desk: Index(desks.length),
    kind: Small,
    op: Schema.Literal("intrude"),
  }),
  Schema.Struct({
    desk: Index(desks.length),
    op: Schema.Literal("bind"),
    project: Index(projects.length),
  }),
  Schema.Struct({
    desk: Index(desks.length),
    id: Index(3),
    index: Small,
    op: Schema.Literal("remember"),
  }),
]);

const did = (index: number) => desks[index] ?? stranger;

const toCommand = (spec: typeof Spec.Type) => {
  if (spec.op === "post") {
    return postCommand({
      ...spec,
      author: authors[spec.author] ?? stranger,
      desk: did(spec.desk),
      kind: kinds[spec.kind] ?? "fyi",
    });
  }

  if (spec.op === "reingest" || spec.op === "tamper") {
    return reingestCommand(did(spec.desk), spec.index, spec.op === "tamper");
  }

  if (spec.op === "ack") {
    return ackCommand(did(spec.desk), spec.indices, spec.stray);
  }

  if (spec.op === "wake") {
    return wakeCommand(did(spec.desk));
  }

  if (spec.op === "restart") {
    return restartCommand(did(spec.desk));
  }

  if (spec.op === "fork") {
    return forkCommand(did(spec.from), did(spec.to), spec.fraction);
  }

  if (spec.op === "intrude") {
    return intruderCommand(
      did(spec.desk),
      authors[spec.author] ?? stranger,
      spec.kind
    );
  }

  if (spec.op === "bind") {
    return bindCommand(did(spec.desk), spec.project);
  }

  return rememberCommand(did(spec.desk), spec.index, spec.id);
};

const [alice = stranger, bob = stranger] = authors;

const scenario = [
  postCommand({
    author: alice,
    desk: first,
    kind: "progress",
    mention: false,
    project: 0,
    selfPost: false,
  }),
  postCommand({
    author: bob,
    desk: first,
    kind: "question",
    mention: true,
    project: 2,
    selfPost: false,
  }),
  postCommand({
    author: alice,
    desk: first,
    kind: "progress",
    mention: false,
    project: 2,
    selfPost: true,
  }),
  reingestCommand(first, 0, false),
  reingestCommand(first, 1, true),
  rememberCommand(first, 0, 0),
  rememberCommand(first, 0, 1),
  ackCommand(first, [1], true),
  restartCommand(first),
  forkCommand(first, third, 1),
  forkCommand(first, second, 1),
  forkCommand(third, first, 0),
  forkCommand(third, desks[3] ?? stranger, 0),
  ackCommand(first, [0], false),
  ackCommand(second, [2], false),
  forkCommand(first, second, 1),
  bindCommand(third, 1),
  postCommand({
    author: alice,
    desk: third,
    kind: "fyi",
    mention: false,
    project: 0,
    selfPost: false,
  }),
  bindCommand(third, 0),
  intruderCommand(first, alice, 0),
  intruderCommand(first, bob, 2),
  intruderCommand(first, alice, 3),
  wakeCommand(first),
  restartCommand(second),
];

const deskModel = (
  invariant: Invariant,
  specs: readonly (typeof Spec.Type)[]
) =>
  Effect.gen(function* deskModelRun() {
    const sql = new Map<string, Sql>();

    for (const desk of desks) {
      sql.set(desk, (yield* testStoreFor(desk)).sql);
    }

    const stores = new Map<string, Layer.Layer<DeskStore>>();

    const storeOf = (desk: string) => {
      const found = stores.get(desk);

      if (found !== undefined) {
        return found;
      }

      const database = sql.get(desk);

      if (database === undefined) {
        throw new Error(`Unknown desk ${desk}`);
      }

      const layer = deskStore(database);
      stores.set(desk, layer);

      return layer;
    };

    const registry = Layer.succeed(
      DeskRegistry,
      DeskRegistry.of({
        parent: (destination) =>
          Effect.succeed(destination === second ? first : undefined),
        snapshot: (from: string, atSeq: number) =>
          DeskStore.use((store) =>
            store.transaction((tx) => tx.snapshot(atSeq))
          ).pipe(
            Effect.provide(storeOf(from)),
            Effect.map((snapshot: DeskSnapshotValue) =>
              Schema.decodeSync(Schema.fromJsonString(DeskSnapshot))(
                Schema.encodeSync(Schema.fromJsonString(DeskSnapshot))(snapshot)
              )
            )
          ),
      })
    );

    const context = yield* Effect.context();

    const run = async <A, E>(effect: Effect.Effect<A, E>) =>
      // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check AsyncCommand requires a Promise; the owning property uses it.effect.
      await Effect.runPromiseWith(context)(effect);

    const real: Real = {
      call: async (desk, caller, request) =>
        await run(
          deskRoute(request).pipe(
            Effect.provide(
              deskHandlers(desk, [third]).pipe(
                Layer.provide(storeOf(desk)),
                Layer.provide(registry),
                Layer.provide(Layer.succeed(Caller, { did: caller }))
              )
            )
          )
        ),
      cid: async (item) =>
        await run(ownerCid(Schema.decodeUnknownSync(Schema.JsonObject)(item))),
      invariant,
      restart: (desk) => {
        stores.delete(desk);
      },
    };

    yield* Effect.tryPromise({
      catch: (cause) => new TestFailure({ message: String(cause) }),
      try: async () => {
        await fc.asyncModelRun(
          () => ({
            model: { clock: 0, desks: new Map(), serial: 0 },
            real,
          }),
          [...scenario, ...specs.map(toCommand)]
        );
      },
    });
  }).pipe(Effect.scoped);

const gate = (name: string, invariant: Invariant) => {
  it.effect.prop(
    name,
    [Arbitrary.array(Arbitrary.schema(Spec), { maxLength: 40 })],
    ([specs]) => deskModel(invariant, specs),
    { arbitrary: { runs: 30 }, timeout: 60_000 }
  );
};

gate(
  "no loss: every ingested item stays retrievable until acked, and after",
  "noLoss"
);

gate(
  "no double delivery: an acked item never appears undelivered again",
  "noDoubleDelivery"
);

gate("the delivery cursor never regresses, across restarts", "cursorMonotonic");

gate(
  "a fork inherits the cursor at its fork point and then progresses independently",
  "forkInheritsCursor"
);

gate(
  "dedupe: the same uri and cid is a no-op at its first seq; the same uri with another cid is refused",
  "dedupe"
);

gate(
  "only the desk reads, acks or binds; forks need source ownership and destination lineage or operator authority; others ingest only as author",
  "authorization"
);

gate(
  "a desk bound to a project keeps it and refuses items for another project",
  "project"
);

gate(
  "the first message id remembered for a uri wins and survives restart and fork",
  "replies"
);
