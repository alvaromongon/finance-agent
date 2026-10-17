// Weekly screener: ranks the universe with the mechanical filter 0 and two
// factors (screening-ranking.ts, ADR-0012), takes the best of each silo plus a
// random exploration candidate, analyzes them with technical data + LLM
// reasoning and, if interesting, adds them automatically to watchlist.md with
// their thesis note.
//
// The flow is split into deterministic commands (no LLM) so
// the reasoning is done by a Claude Code Routine without spending
// ANTHROPIC_API_KEY — same handoff pattern as the heartbeat and the
// Monday Briefing:
//
//   npm run screening:prepare    → writes one context file per candidate in
//     logs/pending-screening/ (frontmatter + technicals + system/user prompt)
//   npm run screening:resolve -- <file>  → takes the evaluation JSON on
//     stdin, validates it and runs the deterministic part (screening-log,
//     thesis, watchlist); appends the result to results.jsonl and deletes the file
//   npm run screening:summarize  → composes and sends the run's aggregated
//     email from results.jsonl, and deletes it
//
// The original API mode (npm run weekly-screening, no subcommand) is still
// available as an escape hatch behind the same switch as the heartbeat: with
// ANALYST_PROVIDER=api it calls the API; with "handoff" it fails explicitly
// so the API is not spent by accident.
import { messages, responseLanguageInstruction } from "./i18n/index.js";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { config } from "./config.js";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import { fetchHeadlines } from "./providers/news-provider.js";
import { computeTechnicals } from "./utils/technicals.js";
import {
  appendDecisions,
  readPortfolio,
  readRoutinePrompt,
  readRulesVersion,
  readWatchlist,
  readWatchlistAddedOn,
  retireWatchlistEntry,
  readAllWatchlistTickers,
  readScreeningLog,
  appendScreeningLogEntries,
  addWatchlistEntry,
  writeScreeningCandidate,
  listScreeningCandidateFiles,
  readScreeningCandidate,
  deleteScreeningCandidateFile,
  appendScreeningRunResult,
  readScreeningRunResults,
  deleteScreeningRunResults,
  writeScreeningRunSelection,
  readScreeningRunSelection,
  type ScreeningCandidateMeta,
} from "./vault-io.js";
import { assertSchemaVersion, type ScreeningLogRow as ScreeningLogEntry } from "./utils/vault-parser.js";
import { sendSummaryEmail } from "./mailer.js";
import {
  classifyIndex,
  describeExit,
  describeExitDetail,
  buildThesisNote,
  findTickersWithPendingExitCriteria,
  validateScreeningEvaluation,
  buildScreeningEmailLines,
  buildScreeningEmailSubject,
  type ScreeningResult,
  type ScreeningEvaluation,
  type ScreeningRunSelection,
} from "./utils/screening-helpers.js";
import { scoreConviction } from "./utils/conviction.js";
import { CURRENCIES } from "./types.js";
import type { WatchlistEntry, Currency, AssetClass, Benchmark, PortfolioSnapshot, StrengthSnapshot } from "./types.js";
import { readTextFile } from "./utils/fs-text.js";
import { snapshotFromTechnicals } from "./utils/strength.js";
import { siloValue } from "./utils/sizing.js";
import { describeSetup, detectSetups, evaluateSetup } from "./utils/setups/index.js";
import { mechanicalExits, type WatchlistExit } from "./utils/watchlist-exit.js";
import { fetchBenchmarks } from "./utils/benchmark.js";
import { asHorizon, benchmarkFields, buildDecision, strengthFields, type ScreeningSelection } from "./decisions.js";
import {
  describeRanking,
  drawWithFilterZero,
  historyLoader,
  rankUniverse,
  selectFromRanking,
  UNIVERSE_POOLS,
  type SelectedCandidate,
  type UniverseRanking,
  type UniversePool,
} from "./screening-ranking.js";
import type { HistoricalBar } from "./providers/types.js";

// ── Universe types ───────────────────────────────────────────────────────────

interface UniverseTicker {
  ticker: string;
  name: string;
  market: string;
  currency: Currency;
  asset_class?: AssetClass;
}

type Universe = Record<UniversePool, UniverseTicker[]>;

/** Asset identity the log, the thesis and the watchlist need. */
interface CandidateInfo {
  ticker: string;
  name: string;
  market: string;
  currency: Currency;
  asset_class: AssetClass;
}

export interface PreparedCandidate {
  info: CandidateInfo;
  currentPrice: number;
  technicalsText: string;
  userPrompt: string;
  /** For the decision log. */
  snapshot: DecisionSnapshot;
  /** How it entered the run (ADR-0012); empty if the ranking was unavailable. */
  selection: ScreeningSelection;
  /** What the engine contributes to the conviction rubric. */
  rubric: CandidateRubric;
}

/** Engine data for the rubric and the email, computed in prepare. */
interface CandidateRubric {
  topQuintile: boolean;
  /** Best net R:R among the current setups; absent without a setup. */
  rewardRisk?: number;
  setups: string[];
}

/** Technical snapshot and silo benchmark on the prepare date. */
interface DecisionSnapshot {
  strength?: StrengthSnapshot;
  benchmark?: Benchmark;
}

export interface PreparedScreening {
  today: string;
  systemPrompt: string;
  candidates: PreparedCandidate[];
  /** How the candidates were picked, for the run email (ADR-0012). */
  selection: ScreeningRunSelection;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}
function signedPct(ratio: number): string {
  return `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;
}
function pct(a: number, b: number): string {
  return ((a / b - 1) * 100).toFixed(1) + "%";
}

// ── Universe reading ─────────────────────────────────────────────────────────

export async function readUniverse(): Promise<Universe> {
  const vaultDir = config.paths.vaultProjectDir;
  const raw = await readTextFile(join(vaultDir, "screening-universe.md"));
  assertSchemaVersion(raw, "screening-universe.md");

  // Extract the YAML block
  const match = /```yaml\n([\s\S]*?)\n```/.exec(raw);
  if (!match) throw new Error("No YAML block found in screening-universe.md");
  const parsed = yaml.load(match[1]) as { universe?: Universe };
  const u = parsed?.universe;
  if (!u?.eur || !u?.usd) throw new Error("Invalid universe structure: eur or usd missing");
  return { ...u, commodities: u.commodities ?? [] };
}

// ── Universe review check ────────────────────────────────────────────────────

async function checkUniverseReviewDate(): Promise<string | null> {
  const vaultDir = config.paths.vaultProjectDir;
  const raw = await readTextFile(join(vaultDir, "screening-universe.md")).catch(() => "");
  const match = /^next_review:\s*(\S+)/m.exec(raw);
  if (!match) return null;
  const nextReview = match[1];
  const today = new Date().toISOString().slice(0, 10);
  return nextReview <= today ? nextReview : null;
}

// ── Technical analysis as text ────────────────────────────────────────────────

function buildTechnicalsText(
  ticker: string,
  bars: HistoricalBar[],
  currentPrice: number,
  currency: Currency,
  relativeStrength?: number,
): string {
  const t = computeTechnicals(bars, currentPrice);
  const lines = [
    `Ticker: ${ticker}`,
    `Current price: ${fmt(currentPrice)}`,
    `Bars analyzed: ${bars.length} sessions`,
    `52w High: ${fmt(t.w52High)}  (vs current: ${pct(currentPrice, t.w52High)})`,
    `52w Low: ${fmt(t.w52Low)}   (vs current: ${pct(currentPrice, t.w52Low)})`,
    `Annual range position: ${(t.rangePosition * 100).toFixed(1)}%`,
    `SMA 50d: ${t.sma50 != null ? fmt(t.sma50) : "no data"}`,
    `SMA 200d: ${t.sma200 != null ? fmt(t.sma200) : "no data (use 2y)"}`,
    `Trend bias: ${t.bias}`,
    ...(relativeStrength != null
      ? [`6m relative strength vs ${config.reference[currency]}: ${signedPct(relativeStrength)}`]
      : []),
    `ATR 14d: ${t.atr14 != null ? fmt(t.atr14) : "no data"}`,
    `Supports: ${t.supports.length > 0 ? t.supports.map((s) => fmt(s)).join(", ") : "none identified"}`,
  ];
  return lines.join("\n");
}

/** User prompt per candidate — the same for API mode and the Routine. */
function buildCandidateUserPrompt(
  info: CandidateInfo,
  technicalsText: string,
  watchlistContext: string,
  headlines: string[],
): string {
  return [
    `## Asset to evaluate`,
    technicalsText,
    `Market: ${info.market}`,
    `Currency: ${info.currency}`,
    `Asset type: ${info.asset_class === "commodity" ? "Commodity (ETC/ETF)" : "Stock"}`,
    "",
    `## Current watchlist (to spot thematic duplicates)`,
    watchlistContext || "(empty watchlist)",
    "",
    headlines.length > 0
      ? `## Recent news\n${headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
      : "## Recent news\n(not available)",
    "",
    responseLanguageInstruction(),
  ].join("\n");
}

/**
 * The candidate's current setups in the last session (ADR-0013), with the
 * engine's ticket and eligibility as the heartbeat would see them: the email
 * lists them and the best net R:R scores in the rubric. The reasoner has
 * not given the horizon yet: the watchlist default is used.
 */
function currentSetups(
  info: CandidateInfo,
  bars: HistoricalBar[],
  benchmark: Benchmark | undefined,
  portfolio: PortfolioSnapshot,
): Pick<CandidateRubric, "rewardRisk" | "setups"> {
  const entry: WatchlistEntry = { ...info, horizon: "medium", thesis: "" };
  const evaluations = detectSetups(bars).map((setup) =>
    evaluateSetup(setup, {
      entry,
      bars,
      regime: benchmark?.regime,
      cash: portfolio.cash,
      siloValue: siloValue(portfolio),
    }),
  );
  const ratios = evaluations.flatMap((ev) => (ev.ticket ? [ev.ticket.rrNet] : []));
  return {
    ...(ratios.length > 0 ? { rewardRisk: Math.max(...ratios) } : {}),
    setups: evaluations.map((ev) => describeSetup(ev)),
  };
}

/**
 * Mechanical watchlist exit (ADR-0012 §8) with the run's ranking: removes
 * from watchlist.md and archives the thesis. What is removed stays excluded
 * from this run's selection, which is computed with the previous watchlist.
 */
async function applyMechanicalExits(
  ranking: UniverseRanking<UniverseTicker>,
  universe: readonly UniverseTicker[],
  portfolios: Record<Currency, PortfolioSnapshot>,
  today: string,
): Promise<WatchlistExit[]> {
  const watchlist = [...(await readWatchlist("EUR")), ...(await readWatchlist("USD"))];
  const exits = mechanicalExits({
    watchlist,
    held: new Set(CURRENCIES.flatMap((c) => portfolios[c].positions.map((p) => p.ticker))),
    universe: new Set(universe.map((t) => t.ticker)),
    ranking,
    addedOn: await readWatchlistAddedOn(watchlist),
    today,
  });
  const m = messages();
  for (const exit of exits) {
    console.error(`[screening] Removed from watchlist: ${exit.ticker} (${describeExit(exit)})`);
    await retireWatchlistEntry(
      exit.ticker,
      m.screening.exitArchiveReason(today, describeExitDetail(exit, m)),
      console.error,
    );
  }
  return exits;
}

// ── Deterministic phase before the reasoning ─────────────────────────────────

/**
 * Candidate selection and context gathering, no LLM: universe, exclusions
 * (watchlist + recent `not_interesting`), universe ranking with the
 * mechanical filter 0 (ADR-0012), Yahoo technicals and headlines. If the
 * ranking is not reliable, it draws as before the ranking existed, only among those passing
 * filter 0 and without downloading again what was already downloaded. Shared
 * by API mode and screening:prepare. Progress goes to stderr so that in
 * prepare mode stdout only holds the created files.
 */
export async function prepareScreening(
  provider: {
    getHistorical: (t: string, r: "1y") => Promise<HistoricalBar[]>;
    getPrices: (t: string[]) => Promise<Map<string, number>>;
  } = new YahooFinanceProvider(),
  headlinesFetcher: (ticker: string) => Promise<string[]> = fetchHeadlines,
): Promise<PreparedScreening> {
  const today = new Date().toISOString().slice(0, 10);
  const vaultDir = config.paths.vaultProjectDir;

  console.error("[screening] Preparing the weekly screener...");

  const [universe, watchlistTickers, screeningLog, systemPrompt, watchlistRaw, eurPortfolio, usdPortfolio] =
    await Promise.all([
      readUniverse(),
      readAllWatchlistTickers(),
      readScreeningLog(),
      readRoutinePrompt("weekly-screening"),
      readTextFile(join(vaultDir, "watchlist.md")).catch(() => ""),
      readPortfolio("EUR"),
      readPortfolio("USD"),
    ]);
  const portfolios: Record<Currency, PortfolioSnapshot> = { EUR: eurPortfolio, USD: usdPortfolio };

  // Tickers to exclude: already in the watchlist + recently analyzed as `not_interesting`
  const excluded = new Set([
    ...watchlistTickers,
    ...screeningLog.filter((e) => e.result === "not_interesting" && e.nextReview > today).map((e) => e.ticker),
  ]);

  const allTickers = UNIVERSE_POOLS.flatMap((pool) => universe[pool]);
  const isExcluded = (ticker: string) => excluded.has(ticker);
  const loadBars = historyLoader(provider);
  console.error(`[screening] Ranking ${allTickers.length} universe securities...`);
  const outcome = await rankUniverse(allTickers, loadBars, today);

  let selected: SelectedCandidate<UniverseTicker>[];
  let retired: WatchlistExit[] | undefined;
  if (outcome.ok) {
    console.error(`[screening] Ranking: ${describeRanking(outcome.ranking)}`);
    retired = await applyMechanicalExits(outcome.ranking, allTickers, portfolios, today);
    selected = selectFromRanking(outcome.ranking, isExcluded);
  } else {
    console.error(`[screening] Ranking unavailable (${outcome.reason.code}): draw with filter 0`);
    selected = await drawWithFilterZero(universe, isExcluded, loadBars, today);
  }
  // Benchmark and regime of each silo, with the history
  // the ranking already downloaded: they go to each decision and the run email.
  const benchmarks = await fetchBenchmarks(
    { getPrices: (tickers) => provider.getPrices(tickers), getHistorical: (ticker) => loadBars(ticker) },
    ["EUR", "USD"],
  );
  const countBySilo = (count: (c: Currency) => number) =>
    Object.fromEntries(CURRENCIES.map((c) => [c, count(c)])) as Record<Currency, number>;
  const selection: ScreeningRunSelection = {
    fallbackReason: outcome.ok ? null : outcome.reason,
    ...(outcome.ok ? { eligibleBySilo: countBySilo((c) => outcome.ranking.bySilo[c].length) } : {}),
    selectedBySilo: countBySilo((c) => selected.filter((s) => s.item.currency === c).length),
    benchmarks,
    ...(retired ? { retired } : {}),
  };

  console.error(
    `[screening] Selected: ${selected.map((c) => c.item.ticker + (c.exploration ? " (exploration)" : "")).join(", ") || "(none)"}`,
  );
  const candidates: PreparedCandidate[] = [];
  for (const sel of selected) {
    const ticker = sel.item;
    try {
      const { bars } = sel;
      const [priceMap, headlines] = await Promise.all([
        provider.getPrices([ticker.ticker]),
        headlinesFetcher(ticker.ticker),
      ]);

      const currentPrice = priceMap.get(ticker.ticker) ?? bars[bars.length - 1].close;
      const technicalsText = buildTechnicalsText(
        ticker.ticker,
        bars,
        currentPrice,
        ticker.currency,
        sel.relativeStrength,
      );
      const t = computeTechnicals(bars, currentPrice);
      const info: CandidateInfo = {
        ticker: ticker.ticker,
        name: ticker.name,
        market: ticker.market,
        currency: ticker.currency,
        asset_class: ticker.asset_class ?? "equity",
      };
      const siloSize = outcome.ok ? outcome.ranking.bySilo[info.currency].length : 0;
      const topQuintile = sel.rank != null && sel.rank <= siloSize * config.framework.screening.conviction.topFraction;

      candidates.push({
        info,
        currentPrice,
        technicalsText,
        userPrompt: buildCandidateUserPrompt(info, technicalsText, watchlistRaw, headlines),
        snapshot: { strength: snapshotFromTechnicals(t), benchmark: benchmarks[info.currency] },
        selection: { rank: sel.rank, score: sel.score, exploration: sel.exploration },
        rubric: { topQuintile, ...currentSetups(info, bars, benchmarks[info.currency], portfolios[info.currency]) },
      });
    } catch (err) {
      console.warn(`[screening] Error preparing ${ticker.ticker}:`, err instanceof Error ? err.message : err);
    }
  }

  return { today, systemPrompt, candidates, selection };
}

// ── Deterministic recording of a result ──────────────────────────────────────

/**
 * Post-processing of an evaluated candidate, shared by both backends: entry
 * in screening-log.md (nextReview +2 months if not interesting) and, if
 * interesting, thesis note + addition to watchlist.md. No entry thresholds:
 * the heartbeat setups decide the entry (ADR-0013). It also adds the line to
 * the decision log, rejections included.
 */
async function recordScreeningResult(
  result: ScreeningResult,
  info: CandidateInfo,
  technicalsText: string,
  snapshot: DecisionSnapshot,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const slug = info.ticker.toLowerCase().replace(/\./g, "");
  // The decision is built (and validated) before writing anything to the vault.
  const decision = buildDecision({
    date: today,
    ticker: info.ticker,
    currency: info.currency,
    origin: "sistema",
    source: "screening",
    type: result.interesting ? "screen_interesting" : "screen_rejected",
    price: result.currentPrice,
    ...benchmarkFields(snapshot.benchmark),
    conviction: result.conviction ?? undefined,
    // The points travel with the decision: the heartbeat inherits the quintile and the catalyst from here.
    conviction_points: result.conviction ? result.convictionPoints : undefined,
    horizon: asHorizon(result.horizon),
    ...strengthFields(snapshot.strength),
    rank: result.rank,
    score: result.score,
    exploration: result.exploration,
    rules_version: await readRulesVersion(),
    log_link: result.interesting ? `tesis/tesis-${slug}.md` : "screening-log.md",
  });

  const entry: ScreeningLogEntry = {
    ticker: info.ticker,
    name: info.name,
    index: result.index,
    date: today,
    result: result.interesting ? "interesting" : "not_interesting",
    summary: result.reason.slice(0, 80).replace(/\|/g, "/"),
    nextReview: result.interesting ? "—" : addMonths(today, 2),
  };
  await appendScreeningLogEntries([entry]);

  if (result.interesting) {
    await createThesisNote(info, result, technicalsText);

    const watchlistEntry: WatchlistEntry = {
      ticker: info.ticker,
      name: info.name,
      market: info.market,
      currency: info.currency,
      horizon: result.horizon ?? "medium",
      asset_class: info.asset_class,
      thesis: result.thesis ?? result.reason,
      thesis_link: `[[tesis-${slug}]]`,
    };
    await addWatchlistEntry(watchlistEntry);
  }

  await appendDecisions([decision]);
}

// ── Create thesis note ───────────────────────────────────────────────────────────

async function createThesisNote(info: CandidateInfo, result: ScreeningResult, technicalsText: string): Promise<void> {
  const vaultDir = config.paths.vaultProjectDir;
  const today = new Date().toISOString().slice(0, 10);
  const slug = info.ticker.toLowerCase().replace(/\./g, "");
  const filename = `tesis-${slug}.md`;

  const content = buildThesisNote({ ticker: info.ticker, name: info.name, slug, today, technicalsText, result });

  await writeFile(join(vaultDir, "tesis", filename), content, "utf8");
  console.log(`[screening] Created ${filename}`);
}

// ── Run aggregated email ─────────────────────────────────────────────────────

/** Returns true if the email went out or was queued in the outbox (see mailer.deliver). */
async function sendScreeningSummary(
  results: ScreeningResult[],
  unresolvedCandidates: string[] = [],
  selection?: ScreeningRunSelection,
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const vaultDir = config.paths.vaultProjectDir;

  const [overdueReview, pendingExitCriteria] = await Promise.all([
    checkUniverseReviewDate(),
    findTickersWithPendingExitCriteria(vaultDir),
  ]);

  const lines = buildScreeningEmailLines(results, {
    today,
    overdueReview,
    pendingExitCriteria,
    unresolvedCandidates,
    selection,
  });

  return sendSummaryEmail(buildScreeningEmailSubject(results), lines.join("\n"));
}

// ── Backend handoff: prepare / resolve / summarize ───────────────

/** Writes the candidate files and returns their names. */
export async function runPrepare(...providerArgs: Parameters<typeof prepareScreening>): Promise<string[]> {
  const { systemPrompt, candidates, selection } = await prepareScreening(...providerArgs);
  await writeScreeningRunSelection(selection);

  if (candidates.length === 0) {
    console.error("[screening] No assets available to analyze. Done.");
    return [];
  }

  const filenames: string[] = [];
  for (const c of candidates) {
    const meta: ScreeningCandidateMeta = {
      ticker: c.info.ticker,
      name: c.info.name,
      market: c.info.market,
      currency: c.info.currency,
      asset_class: c.info.asset_class,
      price: c.currentPrice,
      strength: c.snapshot.strength,
      benchmark: c.snapshot.benchmark,
      ...c.selection,
      ...c.rubric,
    };
    filenames.push(
      await writeScreeningCandidate(meta, {
        systemPrompt,
        userPrompt: c.userPrompt,
        technicalsText: c.technicalsText,
      }),
    );
  }
  console.error(`[screening] ${filenames.length} candidate(s) in logs/pending-screening/`);
  return filenames;
}

/** Extracts the technical data block from the candidate file (for the thesis note). */
function extractTechnicalsText(content: string): string {
  const match = /## Technicals\n\n```\n([\s\S]*?)\n```/.exec(content);
  if (!match) {
    throw new Error("The candidate file has no '## Technicals' section");
  }
  return match[1];
}

/** Engine conviction: only an interesting candidate has one. */
function rubricConviction(
  interesting: boolean,
  rubric: Pick<CandidateRubric, "topQuintile" | "rewardRisk">,
  benchmark: Benchmark | undefined,
  nextCatalyst: string | null,
): Pick<ScreeningResult, "conviction" | "convictionPoints"> {
  if (!interesting) return { conviction: null, convictionPoints: [] };
  const { conviction, points } = scoreConviction({ ...rubric, regime: benchmark?.regime, nextCatalyst });
  return { conviction, convictionPoints: points };
}

/**
 * Resolves a candidate with the received evaluation (already parsed from
 * stdin): validates the contract, records in screening-log/thesis/watchlist,
 * appends the result for the run email and deletes the candidate file.
 */
export async function resolveScreeningCandidate(filename: string, evaluationInput: unknown): Promise<void> {
  const evaluation: ScreeningEvaluation = validateScreeningEvaluation(evaluationInput);
  const { meta, content } = await readScreeningCandidate(filename);
  const technicalsText = extractTechnicalsText(content);

  const info: CandidateInfo = {
    ticker: meta.ticker,
    name: meta.name,
    market: meta.market,
    currency: meta.currency,
    asset_class: meta.asset_class,
  };

  const result: ScreeningResult = {
    ticker: meta.ticker,
    name: meta.name,
    index: classifyIndex(info),
    currency: meta.currency,
    currentPrice: meta.price,
    interesting: evaluation.interesting,
    ...rubricConviction(evaluation.interesting, meta, meta.benchmark, evaluation.next_catalyst),
    reason: evaluation.reason,
    thesis: evaluation.thesis,
    horizon: evaluation.horizon,
    nextCatalyst: evaluation.next_catalyst,
    invalidation: evaluation.invalidation,
    setups: meta.setups,
    rank: meta.rank,
    score: meta.score,
    exploration: meta.exploration,
  };

  await recordScreeningResult(result, info, technicalsText, { strength: meta.strength, benchmark: meta.benchmark });
  await appendScreeningRunResult(result);
  await deleteScreeningCandidateFile(filename);
  console.log(
    `[screening] Resolved and deleted: ${filename} (${result.interesting ? "interesting" : "not interesting"})`,
  );
}

/**
 * Closes the handoff run: aggregated email from results.jsonl and cleanup.
 * If unresolved candidates remain, the email says so (they are not deleted).
 */
export async function summarizeScreening(): Promise<void> {
  const rawResults = await readScreeningRunResults();
  if (rawResults.length === 0) {
    console.log("[screening] No accumulated results — nothing to summarize.");
    return;
  }
  // appendScreeningRunResult writes results.jsonl with ScreeningResult objects
  // already validated in resolve; here it is only read back.
  const results = rawResults as ScreeningResult[];
  const unresolved = await listScreeningCandidateFiles();
  // runPrepare writes run.json with a ScreeningRunSelection; here it is only read back.
  const selection = ((await readScreeningRunSelection()) ?? undefined) as ScreeningRunSelection | undefined;

  const sent = await sendScreeningSummary(results, unresolved, selection);
  if (!sent) {
    // With no email sent (smtp mode without credentials), deleting results.jsonl
    // would silently lose the summary: it is kept for the Actions relay to
    // process.
    console.warn("[screening] Email not sent — results.jsonl kept for the relay.");
    return;
  }
  await deleteScreeningRunResults();
  console.log(`[screening] Run closed. Interesting: ${results.filter((r) => r.interesting).length}/${results.length}`);
}

// ── API backend (escape hatch) ───────────────────────────────────────────────

async function evaluateWithApi(
  client: Anthropic,
  systemPrompt: string,
  candidate: PreparedCandidate,
): Promise<ScreeningResult> {
  const response = await client.messages.create({
    model: config.claude.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: candidate.userPrompt }],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  const { info, currentPrice, rubric } = candidate;

  // Extract JSON from the code block or directly
  const jsonMatch = /```(?:json)?\n?([\s\S]*?)\n?```/.exec(text) ?? [null, text];
  try {
    const parsed = JSON.parse(jsonMatch[1].trim()) as {
      interesting?: unknown;
      next_catalyst?: unknown;
      reason?: string;
      thesis?: string | null;
      horizon?: "short" | "medium" | null;
      invalidation?: unknown;
    };
    const interesting = Boolean(parsed.interesting);
    const nextCatalyst =
      typeof parsed.next_catalyst === "string" && parsed.next_catalyst.trim() ? parsed.next_catalyst.trim() : null;
    return {
      ticker: info.ticker,
      name: info.name,
      index: classifyIndex(info),
      currency: info.currency,
      currentPrice,
      interesting,
      ...rubricConviction(interesting, rubric, candidate.snapshot.benchmark, nextCatalyst),
      reason: String(parsed.reason ?? messages().screening.noReason),
      thesis: parsed.thesis ?? null,
      horizon: parsed.horizon ?? null,
      nextCatalyst,
      setups: rubric.setups,
      invalidation: Array.isArray(parsed.invalidation)
        ? (parsed.invalidation as unknown[])
            .filter((i): i is string => typeof i === "string" && i.trim() !== "")
            .map((i) => i.trim())
        : [],
    };
  } catch {
    console.warn(`[screening] Could not parse JSON for ${info.ticker}. Response: ${text.slice(0, 200)}`);
    return {
      ticker: info.ticker,
      name: info.name,
      index: info.market,
      currency: info.currency,
      currentPrice,
      interesting: false,
      conviction: null,
      convictionPoints: [],
      reason: messages().screening.parseFailed,
      thesis: null,
      horizon: null,
      nextCatalyst: null,
      invalidation: [],
      setups: rubric.setups,
    };
  }
}

/** Full API mode (escape hatch): prepare → Claude per candidate → recording + email. */
async function runApiScreening(): Promise<void> {
  const { systemPrompt, candidates, selection } = await prepareScreening();

  if (candidates.length === 0) {
    console.log("[screening] No assets available to analyze. Done.");
    return;
  }

  const client = new Anthropic({ apiKey: config.claude.apiKey(), maxRetries: 3 });
  const results: ScreeningResult[] = [];

  for (const candidate of candidates) {
    console.log(`[screening] Analyzing ${candidate.info.ticker}...`);
    try {
      const result = { ...(await evaluateWithApi(client, systemPrompt, candidate)), ...candidate.selection };
      await recordScreeningResult(result, candidate.info, candidate.technicalsText, candidate.snapshot);
      results.push(result);
    } catch (err) {
      console.warn(`[screening] Error in ${candidate.info.ticker}:`, err instanceof Error ? err.message : err);
    }
  }

  await sendScreeningSummary(results, [], selection);
  console.log(`[screening] Done. Interesting: ${results.filter((r) => r.interesting).length}/${results.length}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// CLI dispatch only when the file runs directly — not when the tests import
// it (same pattern as pending.ts and monday-briefing.ts).
const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  const [cmd, arg] = process.argv.slice(2);
  const commands: Record<string, () => Promise<void>> = {
    prepare: async () => {
      const filenames = await runPrepare();
      for (const f of filenames) process.stdout.write(f + "\n");
    },
    resolve: async () => {
      if (!arg) throw new Error("Usage: screening:resolve -- <file>");
      const stdin = await readStdin();
      await resolveScreeningCandidate(arg, JSON.parse(stdin));
    },
    summarize: summarizeScreening,
  };

  const fn =
    cmd != null
      ? commands[cmd]
      : async () => {
          // No subcommand = API mode, guarded by the same switch as the heartbeat and
          // the briefing (ANALYST_PROVIDER): in handoff mode the Routine resolves the
          // screening, and calling the API would be accidental spending.
          if (config.analyst.provider !== "api") {
            throw new Error(
              `ANALYST_PROVIDER="${config.analyst.provider}": API mode is disabled. ` +
                "Use screening:prepare / screening:resolve / screening:summarize (Routine), " +
                "or run with ANALYST_PROVIDER=api as an escape hatch.",
            );
          }
          await runApiScreening();
        };

  if (!fn) {
    throw new Error("Usage: weekly-screening.ts [prepare|resolve|summarize]");
  }
  fn().catch((err) => {
    console.error("[screening] Error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
