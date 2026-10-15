// Entry point of a heartbeat run. Scoped to one currency (silo):
//   npm run heartbeat:eu   -> --currency EUR  (after the European close)
//   npm run heartbeat:us   -> --currency USD  (after the US close)
// The run logic lives in heartbeat-run.ts.
import { createAnalystProvider } from "./analyst/factory.js";
import { assertMailConfigured } from "./mailer.js";
import { createMarketDataProvider } from "./providers/factory.js";
import { runHeartbeat } from "./heartbeat-run.js";
import type { Currency } from "./types.js";

function parseCurrency(argv: string[]): Currency {
  const i = argv.indexOf("--currency");
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (value !== "EUR" && value !== "USD") {
    throw new Error("Usage: --currency <EUR|USD>");
  }
  return value;
}

async function main(): Promise<void> {
  const currency = parseCurrency(process.argv.slice(2));
  console.log(`[finance-agent] Run ${currency} — ${new Date().toISOString()}`);

  // fail-fast: if this environment requires delivery, check it before spending
  // the run. An alert that does not go out is worse than a run that does not
  // run: the failed run shows red, the lost alert shows nowhere.
  assertMailConfigured();

  await runHeartbeat(currency, {
    provider: createMarketDataProvider(),
    analyst: createAnalystProvider(), // fail-fast: validates ANALYST_PROVIDER before touching the vault
  });
}

main().catch((err) => {
  console.error("[finance-agent] Run aborted:", err);
  process.exitCode = 1;
});
