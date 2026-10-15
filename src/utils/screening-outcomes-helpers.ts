// After-the-fact evaluation of the weekly screening: cohorts,
// aggregates and rejection reason. No I/O: the series download lives in
// forward-returns.ts and the report render in screening-outcomes-render.ts.
import { messages, type Messages } from "../i18n/index.js";
import type { HistoricalBar } from "../providers/types.js";
import { SCREENING_RESULTS, type ScreeningLogRow } from "./vault-parser.js";
import { closeOnOrBefore, excessReturn, forwardReturn, type HorizonOutcome } from "./forward-returns.js";
import { mean, median } from "./decisions-evaluation.js";

/** Measured horizons, in the security's own sessions. */
export const HORIZONS = [20, 60] as const;

/**
 * DD-0010 date. It splits two cohorts with opposite criteria: before, what
 * was near highs was rejected (fallen stocks were favored); after, filter 0
 * rejects what is below the SMA200. Mixing them would average two different
 * systems.
 */
export const DD0010_DATE = "2026-08-03";

/**
 * ADR-0012 date (rules 0.5). Since then candidates come from the ranking, not
 * a draw, and the engine applies filter 0: the analyst no longer rejects by it.
 */
export const DD0016_DATE = "2026-09-17";

/**
 * Benchmark per universe block ("Índice" column of the screening-log).
 * Commodities has no benchmark on purpose: the only candidate at hand,
 * 4GLD.DE, is gold only, and comparing silver or a diversified basket with it
 * would measure the divergence between commodities, not the screening's skill.
 */
export const BENCHMARKS: Readonly<Record<string, string>> = {
  "S&P 500": "SPY",
  "Eurostoxx 50": "^STOXX50E",
};

export function benchmarkFor(index: string): string | null {
  return BENCHMARKS[index] ?? null;
}

export type Cohort = "pre" | "post" | "ranking";

export const COHORTS: readonly Cohort[] = ["pre", "post", "ranking"];

export function cohortOf(date: string): Cohort {
  if (date < DD0010_DATE) return "pre";
  return date < DD0016_DATE ? "post" : "ranking";
}

/**
 * Rejection reason inferred from the `Summary` of a `not_interesting` row.
 * Heuristic: the summary is truncated to 80 characters and written by the
 * analyst, so rule order matters ("No supera el filtro 0" contains "supera el
 * filtro 0") and whatever does not fit falls into "other".
 *
 * The patterns read the analyst's summaries, which so far are in Spanish: they
 * match the data, not the output language. The label comes from the catalog.
 */
export function discardReason(summary: string, m: Messages = messages()): string {
  const r = m.outcomes.reasons;
  if (/no supera el filtro 0/i.test(summary)) return r.filter0Failed;
  if (/filtro 0 al l[íi]mite/i.test(summary)) return r.filter0Borderline;
  if (/supera el filtro 0/i.test(summary)) return r.criteriaNotMet;
  if (/driver|duplicad/i.test(summary)) return r.driverCovered;
  if (/insuficiente|incompatible/i.test(summary)) return r.badData;
  if (/bajista/i.test(summary)) return r.downtrend;
  if (isNearHighs(summary)) return r.nearHighs;
  if (/\bcumple\b/i.test(summary)) return r.notEnoughCriteria;
  return r.other;
}

/** Criterion 2 before DD-0010: position ≥ 70% of the yearly range or near/at highs (Spanish summaries). */
function isNearHighs(summary: string): boolean {
  const range = /(\d+(?:[.,]\d+)?)%\s+(?:de su|del)\s+rango/i.exec(summary);
  if (range && Number(range[1].replace(",", ".")) >= 70) return true;
  return /(?:cerca de|en|solo a un \S+ de|a solo \S+ de) m[áa]ximos|pr[áa]cticamente en m[áa]ximo|retrocedido/i.test(
    summary,
  );
}

export interface EvaluatedRow {
  row: ScreeningLogRow;
  cohort: Cohort;
  benchmark: string | null;
  /** Last close ≤ analysis date; null = no usable history. */
  base: HistoricalBar | null;
  horizons: Record<number, HorizonOutcome>;
  /** Inferred rejection reason; null for interesting ones. */
  reason: string | null;
  /** The ticker was evaluated more than once: observations not fully independent. */
  repeated: boolean;
}

function isEvaluable(row: ScreeningLogRow): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(row.date) && SCREENING_RESULTS.includes(row.result);
}

/**
 * Crosses each screening-log row with the series of its ticker and its index.
 * `barsBySymbol` must hold only complete closes (see `loadClosedBars`).
 */
export function evaluateRows(
  rows: ScreeningLogRow[],
  barsBySymbol: Map<string, HistoricalBar[]>,
  horizons: readonly number[] = HORIZONS,
  m: Messages = messages(),
): EvaluatedRow[] {
  const valid = rows.filter(isEvaluable);
  const timesEvaluated = new Map<string, number>();
  for (const r of valid) timesEvaluated.set(r.ticker, (timesEvaluated.get(r.ticker) ?? 0) + 1);

  return valid.map((row) => {
    const bars = barsBySymbol.get(row.ticker) ?? [];
    const benchmark = benchmarkFor(row.index);
    const benchmarkBars = benchmark ? barsBySymbol.get(benchmark) : undefined;

    const outcomes: Record<number, HorizonOutcome> = {};
    for (const h of horizons) {
      const ret = forwardReturn(bars, row.date, h);
      outcomes[h] = { ret, excess: ret ? excessReturn(ret, benchmarkBars) : null };
    }

    return {
      row,
      cohort: cohortOf(row.date),
      benchmark,
      base: closeOnOrBefore(bars, row.date),
      horizons: outcomes,
      reason: row.result === "not_interesting" ? discardReason(row.summary, m) : null,
      repeated: (timesEvaluated.get(row.ticker) ?? 0) > 1,
    };
  });
}

export interface GroupStats {
  /** The group's evaluations, with or without data. */
  total: number;
  /** Horizon completed: the only ones in means, medians and "beats the index". */
  complete: number;
  /** With a base close but the horizon not complete yet. */
  pending: number;
  /** No usable history. */
  missing: number;
  mean: number | null;
  median: number | null;
  /** Complete with a benchmark (excludes commodities or index without data). */
  withBenchmark: number;
  meanExcess: number | null;
  medianExcess: number | null;
  beats: number;
}

/**
 * Aggregates a group of evaluations at a horizon. It only counts completed
 * horizons: averaging a +3% at 5 sessions with a +3% at 60 would mix horizons.
 */
export function groupStats(evals: EvaluatedRow[], horizon: number): GroupStats {
  const returns: number[] = [];
  const excesses: number[] = [];
  let pending = 0;
  let missing = 0;

  for (const e of evals) {
    if (!e.base) {
      missing++;
      continue;
    }
    const outcome = e.horizons[horizon];
    if (!outcome?.ret || outcome.ret.partial) {
      pending++;
      continue;
    }
    returns.push(outcome.ret.pct);
    if (outcome.excess != null) excesses.push(outcome.excess);
  }

  return {
    total: evals.length,
    complete: returns.length,
    pending,
    missing,
    mean: mean(returns),
    median: median(returns),
    withBenchmark: excesses.length,
    meanExcess: mean(excesses),
    medianExcess: median(excesses),
    beats: excesses.filter((x) => x > 0).length,
  };
}

// ─── Series download ─────────────────────────────────────────────────────────

/** Symbols to download: each evaluable ticker plus its block's index, without repeats. */
export function symbolsToFetch(rows: ScreeningLogRow[]): string[] {
  const valid = rows.filter(isEvaluable);
  return [
    ...new Set([
      ...valid.map((r) => r.ticker),
      ...valid.map((r) => benchmarkFor(r.index)).filter((s): s is string => s != null),
    ]),
  ];
}
