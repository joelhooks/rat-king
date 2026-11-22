import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

import { MailboxHealth } from "../../../../packages/mailbox-client/src/health.ts";
import { FleetDigest } from "../../../../stacks/nest/digest-config.ts";
import { Digest } from "../../../../stacks/nest/health.ts";
import {
  projectOpsDigest,
  projectOpsHealth,
} from "../../../../stacks/nest/ops-read.ts";

it.prop(
  "ops-digest withholds diagnostics and waiting mail while preserving status and counters",
  [FleetDigest, Schema.Int],
  ([digest, nonce]) => {
    const diagnostic = `private diagnostic ${nonce}`;

    const output = projectOpsDigest({
      ...digest,
      reasons: [diagnostic],
      waitingMail: [diagnostic],
    });

    expect(JSON.stringify(output)).not.toContain(diagnostic);
    expect(output).toMatchObject({
      comms: digest.comms,
      issueCount: 1,
      mailbox: { status: digest.rat_king.status },
      status: digest.status,
      waitingMailCount: 1,
    });
  }
);

it.prop(
  "ops-health withholds lease holder, wake metadata and host diagnostics while preserving the selected name and storage slots",
  [Digest, MailboxHealth, Schema.Int],
  ([health, facts, nonce]) => {
    const diagnostic = `private diagnostic ${nonce}`;

    const output = projectOpsHealth(
      "example/row",
      {
        ...facts,
        complete: true,
        lease: {
          expiresAt: 100,
          generation: 1,
          holder: diagnostic,
          pane: diagnostic,
        },
        oldestWake: { at: 0, id: diagnostic, sender: diagnostic },
        retired: false,
      },
      { ...health, reasons: [diagnostic] },
      99
    );

    expect(JSON.stringify(output)).not.toContain(diagnostic);
    expect(output).toMatchObject({
      mailbox: {
        status: health.status,
        storage: { slots: health.storage.slots },
      },
      name: "example/row",
      status: "ok",
    });
  }
);
