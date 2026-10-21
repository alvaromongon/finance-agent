// Loads the decision log and the market data and builds the evaluation report.
// Shared by decisions:evaluate (the Markdown report) and decisions:chart (the
// SLI 1 chart), so both come from the same evaluation and plan R is computed
// once. The provider is the configured one (MARKET_DATA_PROVIDER), so the
// fixtures provider makes it work offline on examples/brain.
import { createMarketDataProvider } from "./providers/factory.js";
import { readDecisionHistory, readPortfolio, readRulesVersion } from "./vault-io.js";
import { closeOnOrBefore, historyRangeCovering, loadClosedBars } from "./utils/forward-returns.js";
import { boardWarnings } from "./utils/decisions-evaluation-render.js";
import { assertLotsMatch } from "./utils/lots-check.js";
import { buildEvaluationReport, evaluationSymbols, type EvaluationReport } from "./utils/decisions-evaluation.js";

// Same pair as the Monday Briefing: dollars per euro.
const EUR_USD_TICKER = "EURUSD=X";

/** Evaluates the whole decision log as of now. `tag` prefixes the log lines. */
export async function loadEvaluationReport(tag: string, now = new Date()): Promise<EvaluationReport> {
  const today = now.toISOString().slice(0, 10);

  const [decisions, eur, usd, rulesVersion] = await Promise.all([
    readDecisionHistory(),
    readPortfolio("EUR"),
    readPortfolio("USD"),
    readRulesVersion(),
  ]);
  const portfolios = { EUR: eur, USD: usd };
  // A Volume that is not the sum of its lots, or a lot without an entry in the log, would give wrong R.
  assertLotsMatch(eur, decisions);
  assertLotsMatch(usd, decisions);

  const earliest = decisions.map((d) => d.date).sort()[0] ?? today;
  const range = historyRangeCovering(earliest, today);
  const symbols = [...evaluationSymbols(decisions, portfolios), EUR_USD_TICKER];

  console.log(`${tag} ${decisions.length} decisions, ${symbols.length} symbols (range=${range})...`);
  const provider = createMarketDataProvider();
  if (!provider.getHistorical) throw new Error("The configured market data provider has no historical bars.");
  const bars = await loadClosedBars({ getHistorical: provider.getHistorical.bind(provider) }, symbols, range, now, tag);
  const eurUsd = closeOnOrBefore(bars.get(EUR_USD_TICKER) ?? [], today)?.close ?? null;

  const report = buildEvaluationReport({ decisions, portfolios, bars, asOf: today, rulesVersion, eurUsd });
  for (const group of boardWarnings(report.board)) {
    for (const line of group.lines) console.warn(`${tag} ⚠ ${line}`);
  }
  return report;
}
