import { Effect, Layer, Schedule, Schema } from "effect";

import { codePoints } from "./code-points.ts";
import type {
  CandidateValue,
  DraftValue,
  MemoryRecordValue,
  SliceKeyValue,
  SliceResultValue,
  SliceValue,
} from "./contract.ts";
import {
  Candidate,
  CanonSource,
  Draft,
  DefectSignature,
  Failure,
  Judge,
  MemoryRecord,
  Observer,
  PlanSteps,
  Slice,
  SliceSource,
  emptyBooks,
  safePrivacy,
} from "./contract.ts";

export const sha256 = Effect.fn("Remembers.sha256")(function* hash(
  text: string
) {
  const digest = yield* Effect.tryPromise({
    catch: () => new Failure({ code: "digest", operation: "sha256" }),
    try: crypto.subtle.digest.bind(
      crypto.subtle,
      "SHA-256",
      new TextEncoder().encode(text)
    ),
  });

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
});

const redactions: readonly (readonly [RegExp, string])[] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    "[key]",
  ],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/gu, "[token]"],
  [
    /\b(?:ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA|AIza)[A-Za-z0-9_-]{10,}/gu,
    "[token]",
  ],
  [/bearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "Bearer [token]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[email]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[ip]"],
  [/\b[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net\b/gu, "[host]"],
  [/\/(?:Users|home)\/[A-Za-z0-9_-]+/gu, "~"],
  [/\b[A-Fa-f0-9]{40,}\b/gu, "[hex]"],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}/gu, "[blob]"],
];

export const redact = (text: string): string => {
  let result = text;

  for (const [pattern, replacement] of redactions) {
    result = result.replace(pattern, replacement);
  }

  return result;
};

const transcriptSpanSize = 24;

export const safeEvidenceQuote = (quote: string) =>
  redact(quote) === quote && codePoints(quote).length < transcriptSpanSize;

export const retryModel = <A, R>(job: Effect.Effect<A, Failure, R>) =>
  job.pipe(
    Effect.retry({
      schedule: Schedule.exponential("2 seconds").pipe(Schedule.jittered),
      while: (error) =>
        ["429", "503", "server_is_overloaded"].includes(error.code),
    })
  );

const verify = Effect.fn("Remembers.verify")(function* verifyDraft(
  draft: DraftValue,
  slice: SliceValue
) {
  const cites = [];

  for (const evidence of draft.evidence) {
    const chunk = slice.chunks.find((value) => value.id === evidence.chunk_id);

    if (!chunk || codePoints(evidence.quote).length > 280) {
      return null;
    }

    const offset = chunk.text.indexOf(evidence.quote);

    if (offset === -1) {
      return null;
    }

    const start = codePoints(chunk.text.slice(0, offset)).length;
    const end = start + codePoints(evidence.quote).length;

    if (codePoints(chunk.text).slice(start, end).join("") !== evidence.quote) {
      return null;
    }

    if (!safeEvidenceQuote(evidence.quote)) {
      continue;
    }

    cites.push({
      chunk_id: chunk.id,
      end,
      sha256: yield* sha256(evidence.quote),
      start,
    });
  }

  if (cites.length === 0) {
    return null;
  }

  return yield* Schema.decodeUnknownEffect(Candidate)({
    cites,
    claim: draft.claim,
    subject: draft.subject,
  }).pipe(
    Effect.mapError(
      () => new Failure({ code: "candidate", operation: "verify" })
    )
  );
});

const redactCandidate = (candidate: CandidateValue): CandidateValue => ({
  ...candidate,
  claim: {
    ...candidate.claim,
    concepts: [
      redact(candidate.claim.concepts[0]),
      ...candidate.claim.concepts.slice(1).map(redact),
    ],
    defect:
      candidate.claim.defect === null
        ? null
        : {
            component: redact(candidate.claim.defect.component),
            id: redact(candidate.claim.defect.id),
            impact: candidate.claim.defect.impact,
            owner: redact(candidate.claim.defect.owner),
            signature: {
              literal: redact(candidate.claim.defect.signature.literal),
              role:
                candidate.claim.defect.signature.role === null
                  ? null
                  : redact(candidate.claim.defect.signature.role),
            },
          },
    project: redact(candidate.claim.project),
    sentence: redact(candidate.claim.sentence),
  },
  subject: Object.fromEntries(
    Object.entries(candidate.subject).map(([key, value]) => [
      redact(key),
      value,
    ])
  ),
});

const leaksTranscript = (candidate: CandidateValue, slice: SliceValue) => {
  const { defect } = candidate.claim;

  const fields = [
    JSON.stringify(candidate),
    candidate.claim.sentence,
    candidate.claim.project,
    ...candidate.claim.concepts,
    ...Object.keys(candidate.subject),
    ...candidate.cites.flatMap((cite) => [cite.chunk_id, cite.sha256]),
    ...(defect === null
      ? []
      : [
          defect.component,
          defect.id,
          defect.owner,
          defect.signature.literal,
          defect.signature.role ?? "",
        ]),
  ];

  return slice.chunks.some((chunk) => {
    const points = codePoints(chunk.text);

    for (
      let index = 0;
      index + transcriptSpanSize <= points.length;
      index += 1
    ) {
      const fragment = points.slice(index, index + transcriptSpanSize).join("");

      if (fields.some((field) => field.includes(fragment))) {
        return true;
      }
    }

    return false;
  });
};

const gateDraft = Effect.fn("Remembers.gateDraft")(function* gateDraft(
  draft: DraftValue,
  slice: SliceValue,
  books: { -readonly [K in keyof SliceResultValue["books"]]: number }
) {
  if (!safePrivacy(draft.claim)) {
    books.privacy_dropped += 1;

    return null;
  }

  if (
    draft.claim.defect !== null &&
    !Schema.is(DefectSignature)(draft.claim.defect.signature.literal)
  ) {
    books.unsafe_dropped += 1;

    return null;
  }

  const verified = yield* verify(draft, slice);

  if (verified === null) {
    books.cite_failed += 1;

    return null;
  }

  books.cites_verified += verified.cites.length;
  const candidate = redactCandidate(verified);

  if (leaksTranscript(candidate, slice)) {
    books.unsafe_dropped += 1;

    return null;
  }

  const canon = yield* CanonSource;

  if (yield* canon.states(candidate.claim, yield* canon.loaded())) {
    books.novelty_dropped += 1;

    return null;
  }

  return candidate;
});

export const postObservation = Effect.fn("Remembers.postObservation")(
  function* postObservation(slice: SliceValue, drafts: readonly DraftValue[]) {
    const books = { ...emptyBooks(), observed: drafts.length, slices_read: 1 };
    const candidates: CandidateValue[] = [];

    for (const draft of drafts) {
      const accepted = yield* gateDraft(draft, slice, books);

      if (accepted !== null) {
        candidates.push(accepted);
      }
    }

    return { books, candidates, key: slice.key };
  }
);

export const observeSlice = Effect.fn("Remembers.observeSlice")(
  function* observeSlice(key: SliceKeyValue) {
    const source = yield* SliceSource;
    const observer = yield* Observer;

    const slice = yield* source.read(key).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Slice)),
      Effect.mapError(() => new Failure({ code: "slice", operation: "read" }))
    );

    const drafts = yield* retryModel(observer.think(slice)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Draft))),
      Effect.mapError(
        () => new Failure({ code: "observer", operation: "observe" })
      )
    );

    return yield* postObservation(slice, drafts);
  }
);

export const dedupe = Effect.fn("Remembers.dedupe")(function* dedupeResults(
  results: readonly SliceResultValue[],
  at: number
) {
  const records = new Map<string, MemoryRecordValue>();

  for (const result of results) {
    for (const candidate of result.candidates) {
      const id = yield* sha256(
        JSON.stringify([
          candidate.claim.project,
          candidate.claim.sentence.trim().toLowerCase(),
        ])
      );

      const previous = records.get(id);
      const observation = { at, conversation: result.key.conversation };

      if (previous) {
        const cites = new Map(
          previous.cites.map((cite) => [JSON.stringify(cite), cite])
        );

        for (const cite of candidate.cites) {
          cites.set(JSON.stringify(cite), cite);
        }

        const repeated = previous.reobserved.some(
          (item) =>
            item.at === observation.at &&
            item.conversation === observation.conversation
        );

        records.set(
          id,
          MemoryRecord.make({
            ...previous,
            cites: [
              previous.cites[0],
              ...[...cites.values()].filter(
                (cite) =>
                  JSON.stringify(cite) !== JSON.stringify(previous.cites[0])
              ),
            ],
            reobserved: repeated
              ? previous.reobserved
              : [...previous.reobserved, observation],
            stability_days: previous.stability_days + Number(!repeated),
          })
        );
      } else {
        records.set(
          id,
          MemoryRecord.make({
            ...candidate,
            id,
            invalid_at: null,
            reobserved: [observation],
            stability_days: 1,
            uses: [],
            valid_from: at,
          })
        );
      }
    }
  }

  return [...records.values()];
});

export const localSteps = (at: number) =>
  Layer.effect(
    PlanSteps,
    Effect.gen(function* makeSteps() {
      const context = yield* Effect.context<
        CanonSource | Judge | Observer | SliceSource
      >();

      return PlanSteps.of({
        dedupe: (_delivery, results) => dedupe(results, at),
        judge: (_delivery, candidate) =>
          Judge.use((judge) => retryModel(judge.judge(candidate))).pipe(
            Effect.provide(context)
          ),
        think: (_delivery, key) =>
          observeSlice(key).pipe(Effect.provide(context)),
      });
    })
  );
