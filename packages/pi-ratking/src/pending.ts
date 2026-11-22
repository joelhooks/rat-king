import { Reasons, Verdicts } from "@rat-king/ratking-client/attend";
import type { Reason, Verdict } from "@rat-king/ratking-client/attend";
import { DIGEST_REASON } from "@rat-king/ratking-client/delivery";
import { Data, Option, Schema } from "effect";

export const MAIL_MESSAGE = "ratking_message";

export const DIGEST_MESSAGE = "ratking_cc_digest";

export const WAKE_MESSAGE = "ratking_wake";

export const WAKE_REASON = Reasons.intent({ facts: ["wake"] });

export const DEFAULT_DIGEST_MINUTES = 30;

export type DeliverAs = "followUp" | "nextTurn" | "steer";

export type Hold = DeliverAs | "digest";

export type Disposition = Data.TaggedEnum<{
  Inject: { readonly hold: Hold };
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- Effect TaggedEnum requires an intentionally empty payload for this tag-only variant.
  Settle: Record<never, never>;
}>;

export const Dispositions = Data.taggedEnum<Disposition>();

export const verdictToHold = (verdict: Verdict): Disposition =>
  Verdicts.$match(verdict, {
    Later: () => Dispositions.Inject({ hold: "digest" }),
    Never: () => Dispositions.Settle(),
    Next: () => Dispositions.Inject({ hold: "nextTurn" }),
    Now: () => Dispositions.Inject({ hold: "steer" }),
  });

export interface DeliveryHost<A> {
  readonly inject: (hold: Hold) => A;
  readonly settle: () => A;
}

export const applyDelivery = <A>(
  decision: Disposition,
  host: DeliveryHost<A>
): A => {
  if (Dispositions.$is("Inject")(decision)) {
    return host.inject(decision.hold);
  }

  return host.settle();
};

export type DigestVariant = "cc" | "wake";

export interface PendingMail {
  readonly coalesce?: boolean;
  readonly deferToStart?: boolean;
  readonly expiring?: boolean;
  readonly watch?: string;
  readonly wake?: boolean;
  readonly wakeSender?: string;
  readonly content: string;
  readonly deliverAs?: Hold;
  readonly details: unknown;
  readonly digestMinutes?: number | undefined;
  readonly notBefore?: number | undefined;
  readonly reason?: Reason;
  readonly id: string;
  readonly line?: string;
}

export const digestLabel = (reason: Reason = DIGEST_REASON) => {
  if (!Reasons.$is("intent")(reason) || !reason.facts.includes("digest")) {
    return "digest";
  }

  if (reason.facts.includes("quiet")) {
    return "quiet digest";
  }

  return reason.facts.includes("cc") ? "cc digest" : "digest";
};

export const digestReason = (mails: readonly PendingMail[]): Reason => {
  if (mails.every((mail) => digestLabel(mail.reason) === "cc digest")) {
    return DIGEST_REASON;
  }

  if (mails.every((mail) => digestLabel(mail.reason) === "quiet digest")) {
    return Reasons.intent({ facts: ["quiet", "digest"] });
  }

  return Reasons.lever({ facts: ["digest"] });
};

const ShownMail = Schema.Struct({
  customType: Schema.Literals([MAIL_MESSAGE, "ratking_record_notice"]),
  details: Schema.Struct({ id: Schema.String }),
});

const ShownDigest = Schema.Struct({
  customType: Schema.Literals([DIGEST_MESSAGE, WAKE_MESSAGE]),
  details: Schema.Struct({ ids: Schema.Array(Schema.String) }),
});

const ShownArbited = Schema.Struct({
  customType: Schema.Literals([DIGEST_MESSAGE, WAKE_MESSAGE]),
  details: Schema.Struct({
    followUpId: Schema.String,
    receipt: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  }),
});

export interface SessionMessage {
  readonly customType?: string;
  readonly details?: unknown;
  readonly role: string;
}

interface Carried {
  readonly customType: string;
  readonly details?: unknown;
}

const shownIn = (value: Carried): readonly string[] =>
  Option.match(Schema.decodeUnknownOption(ShownMail)(value), {
    onNone: () =>
      Option.match(Schema.decodeUnknownOption(ShownDigest)(value), {
        onNone: () =>
          Option.match(Schema.decodeUnknownOption(ShownArbited)(value), {
            onNone: () => [],
            onSome: (arbited) => arbited.details.receipt.ids,
          }),
        onSome: (digest) => digest.details.ids,
      }),
    onSome: (mail) => [mail.details.id],
  });

export const shownIds = (message: SessionMessage): readonly string[] =>
  message.role === "custom" && message.customType !== undefined
    ? shownIn({ customType: message.customType, details: message.details })
    : [];

export interface HistoryEntry {
  readonly customType?: string;
  readonly details?: unknown;
  readonly type: string;
}

export const shownInHistory = (
  entries: readonly HistoryEntry[]
): ReadonlySet<string> =>
  new Set(
    entries.flatMap((entry) =>
      entry.type === "custom_message" && entry.customType !== undefined
        ? shownIn({ customType: entry.customType, details: entry.details })
        : []
    )
  );

export interface FlushDelivery {
  readonly deliverAs: DeliverAs;
  readonly triggerTurn: boolean;
}

const NEXT_TURN_DELIVERY: FlushDelivery = {
  deliverAs: "nextTurn",
  triggerTurn: false,
};

export interface MailHost {
  readonly digest: (
    mails: readonly PendingMail[],
    variant?: DigestVariant,
    delivery?: FlushDelivery
  ) => void;
  readonly show: (
    pending: PendingMail,
    deliverAs: DeliverAs,
    triggerTurn?: boolean
  ) => void;
}

const held = (mail: PendingMail) => mail.deliverAs === "digest";

const intervalMs = (mails: readonly PendingMail[]) =>
  Math.min(
    ...mails.map((mail) =>
      mail.notBefore === undefined
        ? (mail.digestMinutes ?? DEFAULT_DIGEST_MINUTES)
        : 0
    )
  ) * 60_000;

export const inbox = (host: MailHost) => {
  const pending = new Map<string, PendingMail>();
  const digested = new Set<string>();
  let last = Option.none<number>();

  return {
    clear: () => {
      pending.clear();
      digested.clear();
      last = Option.none();
    },
    empty: () => pending.size === 0,
    flushNext: (delivery: FlushDelivery = NEXT_TURN_DELIVERY) => {
      const due = [...pending.values()].filter(
        (mail) =>
          (mail.deliverAs === "nextTurn" || mail.deferToStart === true) &&
          mail.coalesce === true &&
          !digested.has(mail.id)
      );

      if (due.length === 0) {
        return;
      }

      if (due.length === 1 && due[0] !== undefined && due[0].wake !== true) {
        host.show(due[0], delivery.deliverAs, delivery.triggerTurn);
      } else {
        host.digest(due, "wake", delivery);
      }

      for (const mail of due) {
        if (pending.has(mail.id)) {
          digested.add(mail.id);
        }
      }
    },
    shown: (id: string) => {
      pending.delete(id);
      digested.delete(id);
    },
    take: (taken: PendingMail, hold: Hold) => {
      if (pending.has(taken.id)) {
        return;
      }

      const mail = { ...taken, deliverAs: hold };

      pending.set(mail.id, mail);

      const delivery = mail.deferToStart === true ? "nextTurn" : hold;

      if (
        mail.expiring === true &&
        (delivery === "nextTurn" || delivery === "digest")
      ) {
        digested.add(mail.id);
        host.show(mail, "followUp", false);
      } else if (
        delivery !== "digest" &&
        !(delivery === "nextTurn" && mail.coalesce === true)
      ) {
        digested.add(mail.id);
        host.show(mail, delivery);
      }
    },
    tick: (now: number) => {
      const due = [...pending.values()].filter(
        (mail) =>
          held(mail) &&
          !digested.has(mail.id) &&
          (mail.notBefore === undefined || now >= mail.notBefore)
      );

      if (Option.isNone(last)) {
        last = Option.some(now);

        return;
      }

      if (due.length === 0 || now - last.value < intervalMs(due)) {
        return;
      }

      last = Option.some(now);

      for (const mail of due) {
        digested.add(mail.id);
      }

      host.digest(
        due.toReversed(),
        due.every((mail) => mail.wake === true) ? "wake" : "cc"
      );
    },
    withdraw: (watch: string, sender: string): readonly string[] => {
      const ids = [...pending.values()].flatMap((mail) =>
        mail.watch === watch &&
        mail.wakeSender === sender &&
        !digested.has(mail.id)
          ? [mail.id]
          : []
      );

      for (const id of ids) {
        pending.delete(id);
      }

      return ids;
    },
  };
};

export { digestFor } from "@rat-king/ratking-client/digest";
