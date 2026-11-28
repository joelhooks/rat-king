import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { decodeCursor, encodeCursor } from "../src/cursor.ts";
import type { CursorRequest, CursorValue } from "../src/cursor.ts";
import { didAllowlist } from "../src/documents.ts";
import { nameHealthReaders } from "../src/name-health-http.ts";
import { tid } from "../src/tid.ts";
import { trafficPermission } from "../src/traffic-store.ts";
import { alpha, did, epoch, integer, serial } from "./mailbox-rule-inputs.ts";

const clock = integer(0, 1023);

it.prop(
  "TIDs are fixed-width AT identifiers for arbitrary current clocks",
  [epoch, clock],
  ([now, id]) => {
    expect(tid(now, id)).toMatch(/^[234567a-z]{13}$/u);
  }
);

it.prop(
  "a later millisecond sorts higher even when its clock identifier wraps",
  [epoch, serial],
  ([now, span]) => {
    expect(tid(now, 1023) < tid(now + span, 0)).toBe(true);
  }
);

it.prop(
  "clock identifiers strictly order TIDs generated in the same millisecond",
  [epoch, integer(0, 1022)],
  ([now, id]) => {
    expect(tid(now, id) < tid(now, id + 1)).toBe(true);
  }
);

it.prop(
  "the clock identifier uses only its low ten bits",
  [epoch, clock, serial],
  ([now, id, high]) => {
    expect(tid(now, id + high * 1024)).toBe(tid(now, id));
  }
);

it.prop(
  "TID uses lexicographic native sort for arbitrary out-of-order clock observations",
  [epoch, Schema.Array(integer(0, 1000)).check(Schema.isMaxLength(35))],
  ([now, offsets]) => {
    expect(offsets.map((offset) => tid(now + offset, 5)).toSorted()).toEqual(
      offsets.toSorted((a, b) => a - b).map((offset) => tid(now + offset, 5))
    );
  }
);

const secret = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);

const base = (n: number, extra: number): CursorValue => ({
  fingerprint: `query-${n}`,
  lastSeq: n,
  recipient: did(n),
  throughSeq: n + extra,
  version: 1,
});

const readCursor = (
  cursor: CursorValue,
  override: Partial<CursorRequest> = {}
) =>
  Effect.gen(function* cursorProbe() {
    const token = yield* encodeCursor(cursor, secret);

    return yield* decodeCursor({
      afterSeq: cursor.lastSeq,
      fingerprint: cursor.fingerprint,
      recipient: cursor.recipient,
      secret,
      token,
      watermark: cursor.throughSeq,
      ...override,
    });
  });

it.effect.prop(
  "a signed snapshot accepts the exact last-seen and watermark boundaries",
  [serial, serial],
  ([n, span]) =>
    Effect.gen(function* inclusiveSnapshot() {
      const snapshot = base(n, span);
      expect(yield* readCursor(snapshot)).toEqual(snapshot);
    })
);

it.effect.prop(
  "a signed cursor can never advance past its own snapshot frontier",
  [serial, serial],
  ([n, gap]) =>
    Effect.gen(function* beyondOwnSnapshot() {
      const cursor = { ...base(n, 0), lastSeq: n + gap };

      const result = yield* readCursor(cursor, {
        afterSeq: 0,
        watermark: n + gap,
      }).pipe(Effect.result);

      expect(result).toMatchObject({
        failure: {
          error: "InvalidCursor",
          message: "Cursor position outside snapshot",
        },
      });
    })
);

it.effect.prop(
  "a signed cursor cannot move the caller backward before its already-seen position",
  [serial, serial],
  ([n, gap]) =>
    Effect.gen(function* cursorRegression() {
      const result = yield* readCursor(base(n, gap), { afterSeq: n + 1 }).pipe(
        Effect.result
      );

      expect(result).toMatchObject({
        failure: {
          error: "InvalidCursor",
          message: "Cursor position outside snapshot",
        },
      });
    })
);

it.effect.prop(
  "a snapshot remains valid as the mailbox watermark moves forward",
  [serial, serial],
  ([n, gap]) =>
    Effect.gen(function* laterMail() {
      const cursor = base(n, gap);
      expect(
        yield* readCursor(cursor, { watermark: cursor.throughSeq + 2 * gap })
      ).toEqual(cursor);
    })
);

it.effect.prop(
  "two cursors that encode the same snapshot sign identically despite key order",
  [serial, serial],
  ([n, gap]) =>
    Effect.gen(function* sameSignature() {
      const first = base(n, gap);
      const { fingerprint, lastSeq, recipient, throughSeq, version } = first;
      const a = yield* encodeCursor(first, secret);

      const b = yield* encodeCursor(
        { fingerprint, lastSeq, recipient, throughSeq, version },
        secret
      );

      expect(a).toBe(b);
    })
);

it.prop(
  "health grants combine operator and health reader lists without altering the DIDs",
  [serial, serial],
  ([a, b]) => {
    const operator = did(a);
    const readers = [did(b), did(b + 1)];
    expect(
      nameHealthReaders({
        HEALTH_READER_DIDS: JSON.stringify(readers),
        OPERATOR_DIDS: JSON.stringify([operator]),
      })
    ).toEqual([operator, ...readers]);
  }
);

it.prop(
  "omitting one grant source does not erase the other",
  [serial, Schema.Boolean],
  ([n, operators]) => {
    const value = JSON.stringify([did(n)]);
    expect(
      nameHealthReaders(
        operators ? { OPERATOR_DIDS: value } : { HEALTH_READER_DIDS: value }
      )
    ).toEqual([did(n)]);
  }
);

it.prop(
  "a malformed allowlist cannot be partially interpreted as an authorization grant",
  [serial, serial],
  ([n, number]) => {
    expect(() => didAllowlist(JSON.stringify([did(n), number]))).toThrow();
  }
);

it.prop(
  "allowlists require a JSON list and do not split comma-containing strings",
  [alpha, alpha],
  ([a, b]) => {
    const token = `${a},${b}`;
    expect(() => didAllowlist(JSON.stringify(token))).toThrow();
    expect(didAllowlist(JSON.stringify([token]))).toEqual([token]);
  }
);

it.prop(
  "either independent traffic grant permits the matching DID",
  [serial, Schema.Boolean],
  ([n, operator]) => {
    const granted = [did(n)];
    const other = [did(n + 1)];
    expect(() => {
      trafficPermission(
        did(n),
        operator ? granted : other,
        operator ? other : granted
      );
    }).not.toThrow();
  }
);

it.prop(
  "traffic grants are exact identity matches, not DID prefixes",
  [serial, alpha],
  ([n, suffix]) => {
    const owner = did(n);
    expect(() => {
      trafficPermission(`${owner}:${suffix}`, [owner], [did(n + 1)]);
    }).toThrow();
  }
);
