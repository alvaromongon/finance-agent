// Generates logs/screening-outcomes.md: what happened afterwards to each
// weekly screening evaluation. It measures whether what was marked
// interesting does better than what was rejected and than its block's index,
// at 20 and 60 sessions. No LLM.
//
// It only writes that file: it does not touch screening-log.md, the watchlist
// or the theses.
//
// Usage: npm run screening:outcomes
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import { readTextFile } from "./utils/fs-text.js";
import { parseScreeningLog } from "./utils/vault-parser.js";
import { historyRangeCovering, loadClosedBars } from "./utils/forward-returns.js";
import { evaluateRows, symbolsToFetch } from "./utils/screening-outcomes-helpers.js";
import { renderScreeningOutcomes } from "./utils/screening-outcomes-render.js";

async function main(): Promise<void> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Direct read without catch (unlike vault-io.readScreeningLog): with a
  // wrongly resolved VAULT_PROJECT_DIR, an "empty" log would pass as a report
  // without data instead of the path error it is.
  const logPath = join(config.paths.vaultProjectDir, "screening-log.md");
  const rows = parseScreeningLog(await readTextFile(logPath));
  if (rows.length === 0) {
    console.log("[screening-outcomes] screening-log.md has no evaluations to measure.");
    return;
  }

  const earliest = rows.map((r) => r.date).sort()[0];
  const range = historyRangeCovering(earliest, today);
  const symbols = symbolsToFetch(rows);

  console.log(`[screening-outcomes] ${rows.length} evaluations, ${symbols.length} symbols (range=${range})...`);
  const barsBySymbol = await loadClosedBars(new YahooFinanceProvider(), symbols, range, now, "[screening-outcomes]");

  const evaluated = evaluateRows(rows, barsBySymbol);
  const outPath = join(config.paths.vaultProjectDir, "logs", "screening-outcomes.md");
  await writeFile(outPath, renderScreeningOutcomes(evaluated, today), "utf8");
  console.log(`[screening-outcomes] Saved to ${outPath}`);
}

main().catch((err) => {
  console.error("[screening-outcomes] Error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
