import { NodeRuntime } from "@effect/platform-node";

import { diagnosticsMain } from "./restore-drill-diagnostics.ts";

NodeRuntime.runMain(diagnosticsMain);
