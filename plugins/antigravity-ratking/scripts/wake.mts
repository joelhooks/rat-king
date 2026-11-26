import { connection } from "./transport.mts";

const host = connection(1800);

try {
  await host.initialize();
  const result = await host.call("wake");

  if (result.failed !== undefined) {
    throw new Error("Citizen reader is not ready");
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write(
    "Rat King wake check unavailable; no batch dispatched.\n"
  );
  process.exitCode = 1;
} finally {
  await host.close();
}
