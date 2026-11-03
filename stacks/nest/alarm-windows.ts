import { Clock, Effect, Result, Schema } from "effect";

import type { HostShell } from "../../packages/alchemy-nest/src/host-shell.ts";
import { closedReceiptWindow } from "./alarm-maintenance.ts";
import { WindowReceipt } from "./alarm-sources.ts";

export const windowReceiptsPath = (markerPath: string) =>
  `${markerPath.slice(0, Math.max(0, markerPath.lastIndexOf("/")))}/window-receipts.jsonl`;

export const decodeWindowReceipts = (text: string, now: number) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) =>
      Result.match(
        Schema.decodeUnknownResult(Schema.fromJsonString(WindowReceipt))(line),
        {
          onFailure: () => [],
          onSuccess: (receipt) =>
            closedReceiptWindow(receipt.start, receipt.end, now)
              ? [receipt]
              : [],
        }
      )
    );

export const readWindowReceipts = Effect.fn("Alarm.readWindowReceipts")(
  function* readWindowReceipts(
    shell: Pick<typeof HostShell.Service, "read">,
    markerPath: string
  ) {
    const bytes = yield* shell.read(windowReceiptsPath(markerPath));

    return bytes === undefined
      ? []
      : decodeWindowReceipts(
          new TextDecoder().decode(bytes),
          yield* Clock.currentTimeMillis
        );
  }
);
