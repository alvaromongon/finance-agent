// Pure functions of monday-briefing.ts, extracted so they can be tested
// without importing the script (which runs main() on load — see monday-briefing.ts).
import { en } from "../i18n/en.js";
import { messages, type Messages } from "../i18n/index.js";
import type { HistoricalBar } from "../providers/types.js";
import { computeTechnicals } from "./technicals.js";
import { extractPlanSummary } from "./vault-parser.js";
import { extractProposals, type TickerSnapshot } from "./briefing-decisions.js";
import { describeAdjustStopPreview } from "./sizing.js";
import { describeSetup, detectSetups, evaluateSetup } from "./setups/index.js";
import { asHorizon } from "../decisions.js";
import type { AssetClass, Currency, MarketRegime, PortfolioSnapshot, Position, WatchlistEntry } from "../types.js";
import type { Ticker } from "../ticker.js";

/** Cash and value (cash + positions at market) of a silo. */
export interface SiloState {
  cash: number;
  value: number;
}

/** What buildTechnicalsSection needs for the position stops and the candidates' setups. */
export interface BriefingSizingContext {
  silos: Record<Currency, SiloState>;
  positionsByTicker: ReadonlyMap<Ticker, Position>;
  /** Regime of each silo: in `adverso` no setup is ELIGIBLE. */
  regimes?: Partial<Record<Currency, MarketRegime>>;
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

/**
 * Filters the tickers to remove from the watchlist: a ticker with an open
 * position in either silo is never removed, even if the model lists it in
 * RETIRE (deterministic guardrail, it does not rely on the prompt being
 * followed).
 */
export function filterSafeRetireList(
  toRetire: Ticker[],
  openPositionTickers: ReadonlySet<Ticker>,
): { safe: Ticker[]; blocked: Ticker[] } {
  const safe: Ticker[] = [];
  const blocked: Ticker[] = [];
  for (const ticker of toRetire) {
    (openPositionTickers.has(ticker) ? blocked : safe).push(ticker);
  }
  return { safe, blocked };
}

/** Subset of IMarketDataProvider buildTechnicalsSection needs (history required, unlike the general interface). */
export interface TechnicalsProvider {
  getHistorical(ticker: string, range?: string): Promise<HistoricalBar[]>;
  getPrices<T extends string>(tickers: T[]): Promise<Map<T, number>>;
}

/**
 * Text block with the current technicals (SMA, ATR, 52w range, supports) of
 * each ticker. With `sizing`, it adds the engine's trailing stop for each
 * position and each candidate's current setups (ADR-0013), with their
 * eligibility and ticket: an armed breakout is a Buy Stop that can be left in
 * place this week.
 */
export async function buildTechnicalsSection(
  provider: TechnicalsProvider,
  tickers: Ticker[],
  entriesByTicker?: ReadonlyMap<Ticker, WatchlistEntry>,
  sizing?: BriefingSizingContext,
): Promise<string> {
  if (tickers.length === 0) return "(no assets)";

  const blocks: string[] = [];
  for (const ticker of tickers) {
    try {
      const [bars, priceMap] = await Promise.all([provider.getHistorical(ticker, "1y"), provider.getPrices([ticker])]);
      if (bars.length === 0) {
        blocks.push(`### ${ticker}\n(no technicals available)`);
        continue;
      }
      const currentPrice = priceMap.get(ticker) ?? bars[bars.length - 1].close;
      const t = computeTechnicals(bars, currentPrice);
      const entry = entriesByTicker?.get(ticker);
      const engineLines = sizing ? setupAndStopLines(ticker, currentPrice, t.atr14, bars, entry, sizing) : [];
      blocks.push(
        [
          `### ${ticker}`,
          `Current price: ${fmt(currentPrice)}`,
          `52w High/Low: ${fmt(t.w52High)} / ${fmt(t.w52Low)} (range position: ${(t.rangePosition * 100).toFixed(1)}%)`,
          `SMA 50d/200d: ${t.sma50 != null ? fmt(t.sma50) : "no data"} / ${t.sma200 != null ? fmt(t.sma200) : "no data"}`,
          `Bias: ${t.bias}`,
          `ATR 14d: ${t.atr14 != null ? fmt(t.atr14) : "no data"}`,
          `Supports: ${t.supports.length > 0 ? t.supports.map((s) => fmt(s)).join(", ") : "none identified"}`,
          ...engineLines,
        ].join("\n"),
      );
    } catch (err) {
      blocks.push(`### ${ticker}\n(error fetching technicals: ${(err as Error).message})`);
    }
  }
  return blocks.join("\n\n");
}

/**
 * Open position: the trailing stop the engine would compute. Watchlist
 * candidate: its current setups, or that it has none.
 */
function setupAndStopLines(
  ticker: Ticker,
  price: number,
  atr: number | null,
  bars: HistoricalBar[],
  entry: WatchlistEntry | undefined,
  sizing: BriefingSizingContext,
): string[] {
  const horizon = asHorizon(entry?.horizon) ?? "medium";
  const position = sizing.positionsByTicker.get(ticker);
  if (position) {
    return [
      describeAdjustStopPreview({ price, atr, currentStop: position.stopLoss, horizon, currency: position.currency }),
    ];
  }
  if (!entry) return [];
  const setups = detectSetups(bars);
  if (setups.length === 0) return ["Setups: none in force."];
  const silo = sizing.silos[entry.currency];
  return setups.map(
    (setup) =>
      `Setup: ${describeSetup(evaluateSetup(setup, { entry, bars, regime: sizing.regimes?.[entry.currency], cash: silo.cash, siloValue: silo.value }), en)}`,
  );
}

/**
 * Price and technicals of each ticker to record finalize's decisions
 *. Best-effort per ticker: one that fails is simply not evaluated,
 * as in buildTechnicalsSection.
 */
export async function collectTickerSnapshots(
  provider: TechnicalsProvider,
  tickers: Ticker[],
): Promise<Map<Ticker, TickerSnapshot>> {
  const snapshots = new Map<Ticker, TickerSnapshot>();
  for (const ticker of tickers) {
    try {
      const [bars, priceMap] = await Promise.all([provider.getHistorical(ticker, "1y"), provider.getPrices([ticker])]);
      if (bars.length === 0) continue;
      const price = priceMap.get(ticker) ?? bars[bars.length - 1].close;
      snapshots.set(ticker, { price, technicals: computeTechnicals(bars, price) });
    } catch (err) {
      console.warn(`[monday-briefing] ${ticker}: no technicals to record the decision (${(err as Error).message})`);
    }
  }
  return snapshots;
}

// ─── Weight breakdown by asset class ───────────────────────────────
//
// Deterministic computation, not delegated to the LLM: same principle as
// risk.ts:validateTicket — a concentration check with real money must not
// rely only on the model doing the arithmetic right on the raw tables. It
// only counts open positions (not cash): the "max weight per position" /
// "commodities target" of portfolio-policy.md is over invested capital, not
// over total cash+positions.

export interface PositionWeight {
  ticker: Ticker;
  currency: Currency;
  assetClass: AssetClass;
  valueEur: number;
  pct: number;
}

export interface AssetClassWeight {
  assetClass: AssetClass;
  valueEur: number;
  pct: number;
}

export interface PortfolioWeights {
  totalValueEur: number;
  byAssetClass: AssetClassWeight[];
  byPosition: PositionWeight[];
}

/**
 * Merges the positions of both silos into a single EUR-equivalent view (USD
 * positions are converted by dividing by `eurUsdRate`, i.e. how many USD 1 EUR
 * is worth) and computes the weight of each position and each asset class
 * over the total invested.
 *
 * Each position's `asset_class` is resolved by looking the ticker up in the
 * matching watchlist; if it is not there (it should not happen after a
 * portfolio sync, but it can in historical/test data) it falls back to "equity".
 */
export function computeAssetClassWeights(
  eurPortfolio: PortfolioSnapshot,
  usdPortfolio: PortfolioSnapshot,
  eurWatchlist: WatchlistEntry[],
  usdWatchlist: WatchlistEntry[],
  eurUsdRate: number,
): PortfolioWeights {
  if (!(eurUsdRate > 0)) {
    throw new Error(`computeAssetClassWeights: invalid eurUsdRate (${eurUsdRate})`);
  }

  const assetClassByTicker = new Map<Ticker, AssetClass>();
  for (const entry of [...eurWatchlist, ...usdWatchlist]) {
    assetClassByTicker.set(entry.ticker, entry.asset_class ?? "equity");
  }

  // If an open position is not in the watchlist, the asset-class weight
  // breakdown silently falls back to "equity" — it can skew the commodities %
  // portfolio-policy.md uses as a target. Warn so it does not go unnoticed
  // (it does not block the briefing: it is a warning, not a guardrail).
  function resolveAssetClass(ticker: Ticker): AssetClass {
    const found = assetClassByTicker.get(ticker);
    if (found == null) {
      console.warn(
        `[monday-briefing] Position ${ticker} without a watchlist entry: assuming asset_class "equity" ` +
          `(it can skew the weight breakdown by asset class)`,
      );
      return "equity";
    }
    return found;
  }

  const byPosition: PositionWeight[] = [
    ...eurPortfolio.positions.map((p) => ({
      ticker: p.ticker,
      currency: p.currency,
      assetClass: resolveAssetClass(p.ticker),
      valueEur: p.volume * p.currentPrice,
    })),
    ...usdPortfolio.positions.map((p) => ({
      ticker: p.ticker,
      currency: p.currency,
      assetClass: resolveAssetClass(p.ticker),
      valueEur: (p.volume * p.currentPrice) / eurUsdRate,
    })),
  ].map((p) => ({ ...p, pct: 0 })); // pct is filled in once the total is known

  const totalValueEur = byPosition.reduce((sum, p) => sum + p.valueEur, 0);

  const withPct = byPosition.map((p) => ({
    ...p,
    pct: totalValueEur > 0 ? (p.valueEur / totalValueEur) * 100 : 0,
  }));

  const byAssetClassMap = new Map<AssetClass, number>();
  for (const p of withPct) {
    byAssetClassMap.set(p.assetClass, (byAssetClassMap.get(p.assetClass) ?? 0) + p.valueEur);
  }
  const byAssetClass: AssetClassWeight[] = [...byAssetClassMap.entries()].map(([assetClass, valueEur]) => ({
    assetClass,
    valueEur,
    pct: totalValueEur > 0 ? (valueEur / totalValueEur) * 100 : 0,
  }));

  return { totalValueEur, byAssetClass, byPosition: withPct };
}

/** Formats PortfolioWeights as Markdown text for the briefing prompt. */
export function formatPortfolioWeights(weights: PortfolioWeights): string {
  if (weights.totalValueEur === 0) {
    return "(no open positions — no weights to compute)";
  }

  const lines = [
    `Total invested value (EUR-equivalent): ${fmt(weights.totalValueEur)} €`,
    "",
    "| Asset class | Value (EUR-eq.) | % of portfolio |",
    "|---|---|---|",
    ...weights.byAssetClass
      .sort((a, b) => b.pct - a.pct)
      .map((w) => `| ${w.assetClass} | ${fmt(w.valueEur)} € | ${w.pct.toFixed(1)}% |`),
    "",
    "| Position | Currency | Class | % of portfolio |",
    "|---|---|---|---|",
    ...weights.byPosition
      .sort((a, b) => b.pct - a.pct)
      .map((p) => `| ${p.ticker} | ${p.currency} | ${p.assetClass} | ${p.pct.toFixed(1)}% |`),
  ];
  return lines.join("\n");
}

// ─── USD buffer (ADR-0009 §6) ─────────────────────────────────────────────────
//
// The briefing's only FX decision: convert EUR→USD only what is
// missing for the USD silo's free cash to cover a position of the cap size,
// because pending orders (the Buy Stop of an armed breakout) hold cash. The
// four "FX timing" options were an unmeasured bet on EUR/USD and were removed.
// Deterministic: the engine computes it.

/**
 * USD buffer line for the prompt: covered, or how much is missing in $ (and in
 * € at today's rate, if known) and when to convert it.
 */
export function formatUsdCushion(usd: SiloState, eurUsdRate: number | null, maxPositionPct: number): string {
  const cap = (usd.value * maxPositionPct) / 100;
  const missing = cap - usd.cash;
  if (missing <= 0) {
    return `USD cushion: covered — free cash ${fmt(usd.cash)} $ ≥ per-position cap ${fmt(cap)} $. No need to convert.`;
  }
  const eur =
    eurUsdRate != null && eurUsdRate > 0 ? ` (≈ ${fmt(missing / eurUsdRate)} € at ${eurUsdRate.toFixed(4)})` : "";
  return (
    `USD cushion: ${fmt(missing)} $${eur} missing to cover a position of the cap's size (${fmt(cap)} $). ` +
    "Convert only that, on a business day (0.5%; 0.8% on weekends and holidays)."
  );
}

// ─── Report validation and persistence ───────────────────────────
//
// In handoff mode the report arrives on stdin from a Routine, so the
// equivalent of the API mode stop_reason=max_tokens check is structural: if
// any of the sections the system prompt requires is missing (in particular
// AUTOMATED_ACTIONS, the last one), the report is truncated or malformed and
// finalize must fail before writing anything to the vault.

// Headings routines/monday-briefing.md requires, in order. They are report
// format, so they stay in Spanish. The regexes tolerate the heading level and
// the number prefix ("## 2. Salud de posiciones"), but require real Markdown
// headings.
const MACRO_CONTEXT_HEADING_RE = /^#{1,6}\s.*contexto macro/im;

const REQUIRED_HEADINGS: readonly (readonly [RegExp, string])[] = [
  [/^#{1,6}\s.*resumen ejecutivo/im, "Resumen ejecutivo"],
  [/^#{1,6}\s.*plan de la semana/im, "Plan de la semana"],
  [/^#{1,6}\s.*salud de posiciones/im, "Salud de posiciones"],
  [/^#{1,6}\s.*watchlist/im, "Watchlist — Revisión de umbrales"],
  [MACRO_CONTEXT_HEADING_RE, "Contexto macro y sectorial"],
  [/^#{1,6}\s.*pr[oó]ximos eventos/im, "Próximos eventos a vigilar"],
];

// Section 4 depends on the model using its web search tool (native in the
// Routine, `web_search` in API mode) — the engine cannot check it in handoff
// mode, only require the text to say so: either it cites a real source, or it
// explicitly admits the search failed or was not done (which the system
// prompt already asks for). Without this check, a run that silently loses the
// web search looks identical to one with real-time context.
const CITATION_RE = /\[[^\]]+\]\(https?:\/\/[^)]+\)|https?:\/\/\S+|\bfuente:/i;
// Matches the Spanish disclaimers the report uses (report format, like the headings).
const DISCLAIMER_RE =
  /no en tiempo real|conocimiento entrenado|b[uú]squeda\s+(fall[oó]|no encontr[oó])|sin resultados de b[uú]squeda|no se pudo (buscar|verificar)/i;

/** Text body between a heading and the next one (or the end of the report if there is none). */
function extractSectionBody(report: string, headingRegex: RegExp): string {
  const match = headingRegex.exec(report);
  if (!match) return "";
  const rest = report.slice(match.index + match[0].length);
  const nextHeading = /^#{1,6}\s/m.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

/**
 * Checks the report contains every required section and a processable
 * AUTOMATED_ACTIONS section (RETIRE: line with the same contract as
 * extractRetireList and a non-empty PLAN_SUMMARY). Returns the list of
 * problems found (empty if the report is valid) so the caller reports them
 * all at once.
 */
export function validateBriefingReport(report: string): string[] {
  if (report.trim() === "") return ["the report is empty"];

  const problems: string[] = [];
  for (const [regex, name] of REQUIRED_HEADINGS) {
    if (!regex.test(report)) problems.push(`missing section "${name}"`);
  }

  if (!/^##\s+AUTOMATED_ACTIONS\s*\nRETIRE:/m.test(report)) {
    problems.push("missing section ## AUTOMATED_ACTIONS with the RETIRE: line (truncated report?)");
  } else {
    if (extractPlanSummary(report) === "") {
      problems.push("PLAN_SUMMARY empty or missing in AUTOMATED_ACTIONS");
    }
    // Proposals are recorded in logs/decisions.jsonl: without the
    // line, the plan could not be measured.
    try {
      if (extractProposals(report) === null) {
        problems.push("missing PROPOSALS: line in AUTOMATED_ACTIONS (use PROPOSALS: [] if you propose nothing)");
      }
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Requiring a citation/notice only makes sense if the section really exists —
  // if it is missing, the heading problem above already covers it.
  if (MACRO_CONTEXT_HEADING_RE.test(report)) {
    const macroBody = extractSectionBody(report, MACRO_CONTEXT_HEADING_RE);
    if (!CITATION_RE.test(macroBody) && !DISCLAIMER_RE.test(macroBody)) {
      problems.push(
        'the "Contexto macro y sectorial" section cites no source and does not say explicitly that the web search failed or was not done — check the section 4 instruction in monday-briefing.md',
      );
    }
  }

  return problems;
}

/** Minimal content we need from an Anthropic API ContentBlock. */
interface WebSearchResultLike {
  type: string;
  content?: unknown;
}

/** There was at least one web search with real results (not just attempted). */
export function webSearchSucceeded(blocks: readonly WebSearchResultLike[]): boolean {
  return blocks.some((b) => b.type === "web_search_tool_result" && Array.isArray(b.content));
}

/**
 * Injects a deterministic notice at the start of section 4 when we know for
 * sure (API mode, with real visibility of the `web_search` tool_results) that
 * no search returned results — we do not rely on the model mentioning it on
 * its own. No-op if the search did succeed.
 */
export function injectMacroSearchWarning(report: string, searchSucceeded: boolean, m: Messages = messages()): string {
  if (searchSucceeded) return report;
  const match = MACRO_CONTEXT_HEADING_RE.exec(report);
  if (!match) return report;
  const lineEnd = report.indexOf("\n", match.index);
  const insertAt = lineEnd === -1 ? report.length : lineEnd + 1;
  return report.slice(0, insertAt) + "\n" + m.briefing.macroSearchWarning + report.slice(insertAt);
}

/** Wraps the report with the Monday Briefing log frontmatter. */
export function buildBriefingLogContent(today: string, reportText: string): string {
  return [
    "---",
    `id: ${today.replace(/-/g, "")}-monday-briefing`,
    `title: "Monday Briefing — ${today}"`,
    "tags: [project-note, log, monday-briefing]",
    "status: active",
    `created: ${today}`,
    "---",
    "",
    reportText,
  ].join("\n");
}
