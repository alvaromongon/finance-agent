// Screening universe ranking (ADR-0012).
//
// `screening:prepare` used to draw the candidates at random. Now the engine
// downloads the last year of each universe security and:
//
//   1. Applies the mechanical filter 0: recent data, ≥ 1 year of history,
//      price > SMA200 (which already implies a non-bearish bias) and minimum
//      liquidity.
//   2. Scores each silo's eligibles with two factors: closeness to the 52-week
//      high and 6-month relative strength against the silo benchmark
//      (ADR-0009 §1). The score is the mean of their percentiles.
//   3. Picks the N best per silo not in the watchlist nor recently analyzed,
//      plus random exploration candidates among the remaining eligibles, to
//      measure whether the ranking beats chance.
//
// If the ranking is not reliable, `drawWithFilterZero` draws as before the ranking existed,
// but only among those passing filter 0. Both paths download through the same
// `historyLoader`, which repeats no series. The provider (YahooFinanceProvider)
// handles the pauses and 429 retries.
import { config } from "./config.js";
import type { ScreeningSelection } from "./decisions.js";
import type { HistoricalBar } from "./providers/types.js";
import { CURRENCIES } from "./types.js";
import type { Currency } from "./types.js";
import { daysBetween } from "./utils/forward-returns.js";
import { sma } from "./utils/technicals.js";
import type { Ticker } from "./ticker.js";

/** Blocks of `screening-universe.md`. */
export const UNIVERSE_POOLS = ["eur", "usd", "commodities"] as const;
export type UniversePool = (typeof UNIVERSE_POOLS)[number];

/** Funnel parameters; `config.framework.screening` by default. */
export interface ScreeningRules {
  minSessions: number;
  minMedianTurnover: number;
  turnoverSessions: number;
  maxStaleDays: number;
  relativeStrengthSessions: number;
  rankedBySilo: Readonly<Record<Currency, number>>;
  explorationBySilo: number;
  fallbackDraw: Readonly<Record<UniversePool, number>>;
}

/**
 * Why a security is left out of the ranking. The first five are filter 0;
 * `no_overlap` means there are no dates in common with the benchmark to
 * measure relative strength.
 */
export type ExclusionReason = "no_data" | "stale" | "short_history" | "below_sma200" | "illiquid" | "no_overlap";

export interface RankableTicker {
  ticker: Ticker;
  currency: Currency;
}

export interface RankedTicker<T extends RankableTicker> {
  item: T;
  /** 1 = the silo's best, among all eligibles (including those excluded by watchlist or recency). */
  rank: number;
  /** Mean of the two factors' percentiles, in [0, 1]. */
  score: number;
  /** Last close / 52-week high. */
  proximity: number;
  /** 6-month excess return over the silo benchmark (0.05 = +5 points). */
  relativeStrength: number;
  bars: HistoricalBar[];
}

export interface UniverseRanking<T extends RankableTicker> {
  bySilo: Record<Currency, RankedTicker<T>[]>;
  excluded: { ticker: Ticker; reason: ExclusionReason }[];
}

/** Picked candidate, by ranking or by draw: always with its bars and filter 0 already passed. */
export interface SelectedCandidate<T extends RankableTicker> extends ScreeningSelection {
  item: T;
  bars: HistoricalBar[];
  /** Only if there was a ranking. */
  relativeStrength?: number;
}

// ── Filter 0 ─────────────────────────────────────────────────────────────────

/** Median close × volume of the last `sessions` bars with volume; null without volume. */
export function medianTurnover(bars: readonly HistoricalBar[], sessions: number): number | null {
  const values = bars
    .slice(-sessions)
    .filter((b) => b.volume != null && b.volume > 0)
    .map((b) => b.close * b.volume!)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Mechanical filter 0 (ADR-0012): `null` if the security is eligible. A series
 * whose last session is older than `maxStaleDays` (suspended security or a
 * ticker Yahoo no longer updates) does not pass: its factors would be frozen.
 * Price > SMA200 is enough for the bias: BAJISTA (bearish) requires price <
 * SMA50 < SMA200. Without volume liquidity cannot be checked, so it does not pass.
 */
export function filterZero(
  bars: readonly HistoricalBar[],
  today: string,
  rules: ScreeningRules = config.framework.screening,
): ExclusionReason | null {
  if (bars.length === 0) return "no_data";
  if (daysBetween(bars[bars.length - 1].date, today) > rules.maxStaleDays) return "stale";
  if (bars.length < rules.minSessions) return "short_history";
  const sma200 = sma(
    bars.map((b) => b.close),
    200,
  );
  if (sma200 == null || bars[bars.length - 1].close <= sma200) return "below_sma200";
  const turnover = medianTurnover(bars, rules.turnoverSessions);
  if (turnover == null || turnover < rules.minMedianTurnover) return "illiquid";
  return null;
}

// ── Factors ──────────────────────────────────────────────────────────────────

/** Last close over the bars' high (the downloaded year), capped at 1. */
export function proximityTo52wHigh(bars: readonly HistoricalBar[]): number {
  const high = Math.max(...bars.map((b) => b.high));
  return Math.min(1, bars[bars.length - 1].close / high);
}

/**
 * Excess return over the security's `sessions` sessions against the
 * benchmark on the same dates: the benchmark starts at its last close on or
 * before the security's start date. `null` if either series falls short.
 */
export function relativeStrength(
  bars: readonly HistoricalBar[],
  referenceBars: readonly HistoricalBar[],
  sessions: number,
): number | null {
  if (bars.length <= sessions || referenceBars.length === 0) return null;
  const start = bars[bars.length - 1 - sessions];
  const end = bars[bars.length - 1];
  const refStart = referenceBars.filter((b) => b.date <= start.date).at(-1);
  const refEnd = referenceBars.filter((b) => b.date <= end.date).at(-1);
  if (!refStart || !refEnd || refStart === refEnd) return null;
  return end.close / start.close - refEnd.close / refStart.close;
}

/** Percentile of each value in [0, 1] (0 the lowest); ties share the mean of their positions. */
export function percentileRanks(values: readonly number[]): number[] {
  if (values.length === 1) return [1];
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const result = new Array<number>(values.length);
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].v === order[start].v) end++;
    const pct = (start + end) / 2 / (values.length - 1);
    for (let k = start; k <= end; k++) result[order[k].i] = pct;
    start = end + 1;
  }
  return result;
}

/**
 * Scores and sorts a silo's eligibles. Ties are broken by relative strength
 * and then by ticker, so the order does not depend on the download's.
 */
export function scoreSilo<T extends RankableTicker>(
  entries: readonly Omit<RankedTicker<T>, "rank" | "score">[],
): RankedTicker<T>[] {
  const proximity = percentileRanks(entries.map((e) => e.proximity));
  const strength = percentileRanks(entries.map((e) => e.relativeStrength));
  return entries
    .map((e, i) => ({ ...e, score: Math.round(((proximity[i] + strength[i]) / 2) * 1000) / 1000 }))
    .sort(
      (a, b) =>
        b.score - a.score || b.relativeStrength - a.relativeStrength || a.item.ticker.localeCompare(b.item.ticker),
    )
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

// ── Selection ────────────────────────────────────────────────────────────────

/** The N best non-excluded of each silo and the random exploration among the remaining eligibles. */
export function selectFromRanking<T extends RankableTicker>(
  ranking: UniverseRanking<T>,
  isExcluded: (ticker: Ticker) => boolean,
  rules: Pick<ScreeningRules, "rankedBySilo" | "explorationBySilo"> = config.framework.screening,
  random: () => number = Math.random,
): SelectedCandidate<T>[] {
  return CURRENCIES.flatMap((currency) => {
    const available = ranking.bySilo[currency].filter((r) => !isExcluded(r.item.ticker));
    const top = available.slice(0, rules.rankedBySilo[currency]);
    const exploration = shuffle(available.slice(top.length), random).slice(0, rules.explorationBySilo);
    const toCandidate = (r: RankedTicker<T>, explore: boolean): SelectedCandidate<T> => ({
      item: r.item,
      bars: r.bars,
      rank: r.rank,
      score: r.score,
      relativeStrength: r.relativeStrength,
      ...(explore ? { exploration: true } : {}),
    });
    return [...top.map((r) => toCandidate(r, false)), ...exploration.map((r) => toCandidate(r, true))];
  });
}

/**
 * Fallback draw when the ranking is not reliable: shuffles each universe
 * block and takes the first `fallbackDraw` non-excluded ones that pass filter
 * 0. It only downloads (or reads from cache) the ones it gets to look at.
 */
export async function drawWithFilterZero<T extends RankableTicker>(
  universe: Readonly<Record<UniversePool, readonly T[]>>,
  isExcluded: (ticker: Ticker) => boolean,
  loadBars: HistoryLoader,
  today: string,
  rules: ScreeningRules = config.framework.screening,
  random: () => number = Math.random,
): Promise<SelectedCandidate<T>[]> {
  const selected: SelectedCandidate<T>[] = [];
  for (const pool of UNIVERSE_POOLS) {
    let taken = 0;
    for (const item of shuffle(
      universe[pool].filter((t) => !isExcluded(t.ticker)),
      random,
    )) {
      if (taken === rules.fallbackDraw[pool]) break;
      const bars = await loadBars(item.ticker);
      if (filterZero(bars, today, rules)) continue;
      selected.push({ item, bars });
      taken++;
    }
  }
  return selected;
}

export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ── Building with market data ────────────────────────────────────────────────

/** Below this fraction of the universe with data, the ranking does not represent the universe. */
export const MIN_COVERAGE = 0.8;

export interface HistoricalProvider {
  getHistorical(ticker: string, range: "1y"): Promise<HistoricalBar[]>;
}

/** Last year of a ticker; never throws: without data it returns `[]`. */
export type HistoryLoader = (ticker: string) => Promise<HistoricalBar[]>;

/**
 * Downloads each series once per run, whether the ranking, the fallback draw
 * or the candidate uses it. A failure counts as no data and is not repeated
 * either: the provider already retried on 429, and asking again right when
 * Yahoo is throttling only makes the run longer.
 */
export function historyLoader(provider: HistoricalProvider, log: (msg: string) => void = console.error): HistoryLoader {
  const cache = new Map<string, Promise<HistoricalBar[]>>();
  return (ticker) => {
    let bars = cache.get(ticker);
    if (!bars) {
      bars = provider.getHistorical(ticker, "1y").catch((err: unknown) => {
        log(`[ranking] ${ticker}: no history (${err instanceof Error ? err.message : String(err)})`);
        return [];
      });
      cache.set(ticker, bars);
    }
    return bars;
  };
}

export type RankingOutcome<T extends RankableTicker> =
  { ok: true; ranking: UniverseRanking<T> } | { ok: false; reason: RankingFallback };

/** Why the ranking is not reliable this run, as data: summarize renders it. */
export type RankingFallback =
  | { code: "no_reference_history"; ticker: Ticker }
  | { code: "low_coverage"; withData: number; total: number }
  | { code: "stale_universe"; medianLastBar?: string };

/**
 * Builds the ranking with the year of each security and of the two
 * benchmarks. Returns `ok: false` with the reason if it is not reliable: no
 * recent history for a benchmark, less than 80% of the universe with data, or
 * the universe's median session outside this week (a sign the whole source
 * is lagging, not a single security: filter 0 drops those as `stale`).
 */
export async function rankUniverse<T extends RankableTicker>(
  universe: readonly T[],
  loadBars: HistoryLoader,
  today: string,
  rules: ScreeningRules = config.framework.screening,
): Promise<RankingOutcome<T>> {
  const references = {} as Record<Currency, HistoricalBar[]>;
  for (const currency of CURRENCIES) {
    const ticker = config.reference[currency];
    const bars = await loadBars(ticker);
    if (
      bars.length <= rules.relativeStrengthSessions ||
      daysBetween(bars[bars.length - 1].date, today) > rules.maxStaleDays
    ) {
      return { ok: false, reason: { code: "no_reference_history", ticker } };
    }
    references[currency] = bars;
  }

  const excluded: UniverseRanking<T>["excluded"] = [];
  const eligible = Object.fromEntries(
    CURRENCIES.map((c) => [c, [] as Omit<RankedTicker<T>, "rank" | "score">[]]),
  ) as Record<Currency, Omit<RankedTicker<T>, "rank" | "score">[]>;
  const lastBarDates: string[] = [];

  for (const item of universe) {
    const bars = await loadBars(item.ticker);
    if (bars.length > 0) lastBarDates.push(bars[bars.length - 1].date);
    const reason = filterZero(bars, today, rules);
    if (reason) {
      excluded.push({ ticker: item.ticker, reason });
      continue;
    }
    const strength = relativeStrength(bars, references[item.currency], rules.relativeStrengthSessions);
    if (strength == null) {
      excluded.push({ ticker: item.ticker, reason: "no_overlap" });
      continue;
    }
    eligible[item.currency].push({ item, bars, proximity: proximityTo52wHigh(bars), relativeStrength: strength });
  }

  if (universe.length > 0 && lastBarDates.length / universe.length < MIN_COVERAGE) {
    return { ok: false, reason: { code: "low_coverage", withData: lastBarDates.length, total: universe.length } };
  }
  const medianLastBar = lastBarDates.sort()[Math.floor((lastBarDates.length - 1) / 2)];
  if (!medianLastBar || daysBetween(medianLastBar, today) > rules.maxStaleDays) {
    return { ok: false, reason: { code: "stale_universe", medianLastBar } };
  }

  const bySilo = Object.fromEntries(CURRENCIES.map((c) => [c, scoreSilo(eligible[c])])) as Record<
    Currency,
    RankedTicker<T>[]
  >;
  return { ok: true, ranking: { bySilo, excluded } };
}

/** One-line summary for prepare's progress: eligibles per silo and exclusions by reason. */
export function describeRanking<T extends RankableTicker>(ranking: UniverseRanking<T>): string {
  const counts = new Map<ExclusionReason, number>();
  for (const e of ranking.excluded) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  const silos = CURRENCIES.map((c) => `${c} ${ranking.bySilo[c].length}`).join(", ");
  const reasons = [...counts].map(([r, n]) => `${r} ${n}`).join(", ") || "none";
  return `eligible ${silos}; out of the ranking: ${reasons}`;
}
