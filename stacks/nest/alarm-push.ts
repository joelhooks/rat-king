import { Clock, Console, Effect, Option } from "effect";

import { SecretStore } from "../../apps/mailbox/cli/secrets.ts";
import type { NoticeValue } from "../../packages/lexicon/src/device.pendingPush.ts";
import { apnsSender } from "./alarm-apns.ts";
import type { SendPush } from "./alarm-apns.ts";
import type { AlarmSettingsValue } from "./alarm-config.ts";
import { prepareAlarmMail } from "./alarm-mail.ts";
import type { PushAttemptsValue } from "./alarm-push-state.ts";
import type { StageConfigValue } from "./stage-config.ts";

interface PushSighting {
  readonly name: string;
  readonly notice: NoticeValue | undefined;
}

const fact = (action: string, name?: string) =>
  Console.log(JSON.stringify({ action, name }));

export const loadAlarmPush = Effect.fn("Alarm.loadPush")(
  function* loadAlarmPush(config: AlarmSettingsValue["push"]) {
    if (config === undefined) {
      return null;
    }

    const secrets = yield* SecretStore;
    const leased = yield* secrets.lease(config.secret).pipe(Effect.option);

    const send = Option.isSome(leased) ? yield* apnsSender(leased.value) : null;

    if (send === null) {
      yield* fact("push.unconfigured");
    }

    return send;
  }
);

export const collectPush = Effect.fn("Alarm.collectPush")(
  function* collectPush(config: StageConfigValue, names: readonly string[]) {
    const { client, targets } = yield* prepareAlarmMail(
      config,
      names,
      "",
      true
    );

    return yield* Effect.forEach(
      names,
      (name) => {
        const target = targets.find((candidate) => candidate.name === name);

        return target === undefined
          ? Effect.succeed({ name, notice: undefined })
          : client.pendingPush(target.did).pipe(
              Effect.map(({ notice }) => ({ name, notice })),
              Effect.orElseSucceed(() => ({ name, notice: undefined }))
            );
      },
      { concurrency: 4 }
    );
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.timeout("8 seconds"),
      Effect.orElseSucceed(() => [])
    )
);

export const dispatchPush = Effect.fn("Alarm.dispatchPush")(
  function* dispatchPush<E, R>(
    prior: PushAttemptsValue,
    seen: readonly PushSighting[],
    send: SendPush,
    save: (attempts: PushAttemptsValue) => Effect.Effect<void, E, R>
  ) {
    const now = yield* Clock.currentTimeMillis;
    const next = new Map(Object.entries(prior));
    const ready = new Map<string, NoticeValue>();

    for (const { name, notice } of seen) {
      const last = next.get(name);

      if (
        notice === undefined ||
        (last !== undefined &&
          (notice.messageId === last.messageId ||
            notice.admissionSeq <= last.admissionSeq ||
            now - last.at < 60_000))
      ) {
        continue;
      }

      next.set(name, {
        admissionSeq: notice.admissionSeq,
        at: now,
        messageId: notice.messageId,
      });
      ready.set(name, notice);
    }

    if (ready.size === 0) {
      return;
    }

    yield* save(Object.fromEntries(next));
    yield* Effect.forEach(
      ready,
      ([name, notice]) =>
        send(notice).pipe(
          Effect.flatMap((ok) => fact(ok ? "push.sent" : "push.failed", name))
        ),
      { concurrency: 4, discard: true }
    );
  }
);
