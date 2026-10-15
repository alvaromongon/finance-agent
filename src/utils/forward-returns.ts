// Forward returns over daily close series. No I/O of its own and no config:
// the download takes the provider as a parameter. Used by
// screening-outcomes.ts and decisions-evaluate.ts:
// any "what happened N sessions after this date?" must come from here, not
// be reimplemented.
import type { HistoricalBar, IMarketDataProvider } from "../providers/types.js";

/**
 * Maximum age (calendar days) of the base close relative to the requested
 * date. A long weekend with a holiday is 4-5 days; beyond that, the ticker was
 * not trading or the history has a gap, and measuring from that close would
 * mean measuring from a price nobody saw on the decision day.
 */
export const MAX_BASE_LAG_DAYS = 7;

/** Calendar days between two YYYY-MM-DD dates (positive if `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Index of the last bar dated ≤ `date`, or -1 if there is none or that bar is
 * older than `maxLagDays`. Bars in chronological order.
 */
export function barIndexOnOrBefore(bars: HistoricalBar[], date: string, maxLagDays = MAX_BASE_LAG_DAYS): number {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= date) return daysBetween(bars[i].date, date) <= maxLagDays ? i : -1;
  }
  return -1;
}

/** Last close ≤ `date` (e.g. Friday for a Saturday screening). */
export function closeOnOrBefore(
  bars: HistoricalBar[],
  date: string,
  maxLagDays = MAX_BASE_LAG_DAYS,
): HistoricalBar | null {
  const i = barIndexOnOrBefore(bars, date, maxLagDays);
  return i === -1 ? null : bars[i];
}

export interface ForwardReturn {
  baseDate: string;
  baseClose: number;
  endDate: string;
  endClose: number;
  /** Sessions actually elapsed between base and end (≤ those requested). */
  sessions: number;
  /** Return in %: 3.2 = +3.2%. */
  pct: number;
  /** The horizon is not complete yet: it measures up to the last available close. */
  partial: boolean;
}

/** What happened at a horizon: asset return and excess over its benchmark. */
export interface HorizonOutcome {
  /** null = no base close or no later session yet. */
  ret: ForwardReturn | null;
  /** Percentage points against the benchmark; null without a benchmark. */
  excess: number | null;
}

/**
 * Return from the last close ≤ `date` to `sessions` sessions later. If the
 * series does not reach that far, it measures up to the last close and marks
 * it `partial`. Returns null without a base close or any later session.
 */
export function forwardReturn(
  bars: HistoricalBar[],
  date: string,
  sessions: number,
  maxLagDays = MAX_BASE_LAG_DAYS,
): ForwardReturn | null {
  const i = barIndexOnOrBefore(bars, date, maxLagDays);
  if (i === -1) return null;
  const j = Math.min(i + sessions, bars.length - 1);
  if (j === i) return null;

  const base = bars[i];
  const end = bars[j];
  return {
    baseDate: base.date,
    baseClose: base.close,
    endDate: end.date,
    endClose: end.close,
    sessions: j - i,
    pct: pctChange(base.close, end.close),
    partial: j - i < sessions,
  };
}

/** Return in % between the closes ≤ `fromDate` and ≤ `toDate`. */
export function returnBetween(
  bars: HistoricalBar[],
  fromDate: string,
  toDate: string,
  maxLagDays = MAX_BASE_LAG_DAYS,
): number | null {
  const from = closeOnOrBefore(bars, fromDate, maxLagDays);
  const to = closeOnOrBefore(bars, toDate, maxLagDays);
  if (!from || !to) return null;
  return pctChange(from.close, to.close);
}

/**
 * Excess return (percentage points) over a benchmark measured between the
 * SAME dates as the asset. It aligns by date and not by number of sessions
 * because asset and index do not always share holidays (a Madrid stock
 * against the Eurostoxx 50, e.g.).
 */
export function excessReturn(asset: ForwardReturn, benchmarkBars: HistoricalBar[] | undefined): number | null {
  if (!benchmarkBars) return null;
  const bench = returnBetween(benchmarkBars, asset.baseDate, asset.endDate);
  return bench == null ? null : asset.pct - bench;
}

/**
 * UTC hour from which the daily bar of any universe market is already a
 * close: the US closes at 20:00 UTC in summer and 21:00 in winter; Europe,
 * earlier. Fixing it in UTC makes the cutoff independent of the time zone of
 * the machine generating the report.
 */
export const MARKET_CLOSE_UTC_HOUR = 22;

/**
 * Drops the bars that at `now` are not a close yet. During the session, Yahoo
 * returns the day's bar with the last tick, and a report regenerated at
 * another time would give another number. The cutoff goes by close time and
 * not by date: with the UTC date as cutoff, a report generated on Friday at
 * 23:00 UTC (early Saturday in Madrid) dropped Friday's already complete close.
 */
export function closedBars(bars: HistoricalBar[], now: Date): HistoricalBar[] {
  const closeTime = `T${String(MARKET_CLOSE_UTC_HOUR).padStart(2, "0")}:00:00Z`;
  return bars.filter((b) => Date.parse(`${b.date}${closeTime}`) <= now.getTime());
}

/** chart endpoint `range` covering from `earliest` (with margin for the base close). */
export function historyRangeCovering(earliest: string, asOf: string): string {
  const days = daysBetween(earliest, asOf) + 2 * MAX_BASE_LAG_DAYS;
  if (days <= 365) return "1y";
  if (days <= 730) return "2y";
  if (days <= 1825) return "5y";
  return "max";
}

function pctChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

/** All the download needs from a market provider. */
export type HistoricalSource = Required<Pick<IMarketDataProvider, "getHistorical">>;

/**
 * Downloads each symbol's history, sequentially (the provider applies its
 * rate-limit pause and retries on 429), and keeps the complete closes at
 * `now`. A failing symbol is warned about and skipped: it shows as "no data"
 * in the report instead of aborting the rest of the download.
 */
export async function loadClosedBars(
  source: HistoricalSource,
  symbols: string[],
  range: string,
  now: Date,
  logPrefix = "[forward-returns]",
): Promise<Map<string, HistoricalBar[]>> {
  const barsBySymbol = new Map<string, HistoricalBar[]>();
  for (const symbol of symbols) {
    try {
      barsBySymbol.set(symbol, closedBars(await source.getHistorical(symbol, range), now));
    } catch (err) {
      console.warn(`${logPrefix} No history for ${symbol}:`, err instanceof Error ? err.message : err);
    }
  }
  return barsBySymbol;
}
