// Generates logs/decisions-evaluation.md: the cutoff criterion
// table (ADR-0009 §4) and what happened after each decision in the log
// (ADR-0006). No LLM. It is step 1 of the Monday Briefing: prepare puts the
// table in the prompt. Replaces outcomes.ts.
//
// It only writes that file: it does not touch the decision log, portfolio.md
// or the watchlist.
//
// Usage: npm run decisions:evaluate
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import { readDecisionHistory, readPortfolio, readRulesVersion } from "./vault-io.js";
import { closeOnOrBefore, historyRangeCovering, loadClosedBars } from "./utils/forward-returns.js";
import { buildEvaluationReport, evaluationSymbols } from "./utils/decisions-evaluation.js";
import { renderDecisionsEvaluation } from "./utils/decisions-evaluation-render.js";

// Same pair as the Monday Briefing: dollars per euro.
const EUR_USD_TICKER = "EURUSD=X";

async function main(): Promise<void> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const [decisions, eur, usd, rulesVersion] = await Promise.all([
    readDecisionHistory(),
    readPortfolio("EUR"),
    readPortfolio("USD"),
    readRulesVersion(),
  ]);
  const portfolios = { EUR: eur, USD: usd };

  const earliest = decisions.map((d) => d.date).sort()[0] ?? today;
  const range = historyRangeCovering(earliest, today);
  const symbols = [...evaluationSymbols(decisions, portfolios), EUR_USD_TICKER];

  console.log(`[decisions-evaluate] ${decisions.length} decisions, ${symbols.length} symbols (range=${range})...`);
  const bars = await loadClosedBars(new YahooFinanceProvider(), symbols, range, now, "[decisions-evaluate]");
  const eurUsd = closeOnOrBefore(bars.get(EUR_USD_TICKER) ?? [], today)?.close ?? null;

  const report = buildEvaluationReport({ decisions, portfolios, bars, asOf: today, rulesVersion, eurUsd });
  for (const w of report.board.silos.flatMap((s) => s.warnings)) console.warn(`[decisions-evaluate] ⚠ ${w}`);

  const outPath = join(config.paths.vaultProjectDir, "logs", "decisions-evaluation.md");
  await writeFile(outPath, renderDecisionsEvaluation(report), "utf8");
  console.log(`[decisions-evaluate] Saved to ${outPath}`);
}

main().catch((err) => {
  console.error("[decisions-evaluate] Error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
