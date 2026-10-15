// Real value of each silo, shadow portfolio and drawdown (
// ADR-0009 §1 and §4). Pure functions: decisions-evaluate.ts supplies the log,
// portfolio.md and the series.
//
// The decision log (ADR-0006) does not store the silo value, but it does store
// every trade and every money flow. So the value is rebuilt backwards from
// today's portfolio.md state: the trades and flows recorded since the start
// date are undone and each session is valued at the close. If something is
// missing from the log, the reconstruction does not add up (negative cash or
// units at the start) and a warning is raised instead of hiding it.
import { messages, type Messages } from "../i18n/index.js";
import type { Decision } from "../decisions.js";
import type { HistoricalBar } from "../providers/types.js";
import type { Currency, PortfolioSnapshot } from "../types.js";
import { closeOnOrBefore, daysBetween } from "./forward-returns.js";

/** Rounding tolerance: cents in cash, ten-thousandths in units. */
const CASH_EPSILON = 0.01;
const UNITS_EPSILON = 1e-4;

/** Money entering (+) or leaving (−) a silo without being a trade. */
export interface SiloFlow {
  date: string;
  amount: number;
}

/**
 * Amount of a flow for silo `currency`, or `null` if the decision moves no
 * money in that silo. A conversion leaves the source silo for the converted
 * amount and reaches the other net of the fee (ADR-0009 §1): with two
 * currencies, the other silo is always the target.
 */
export function flowAmount(d: Decision, currency: Currency): number | null {
  if (d.amount == null) return null;
  switch (d.type) {
    case "deposit":
      return d.currency === currency ? d.amount : null;
    case "withdrawal":
      return d.currency === currency ? -d.amount : null;
    case "fx_conversion":
      if (d.currency === currency) return -d.amount;
      return d.fx_rate != null ? (d.amount - (d.costs ?? 0)) * d.fx_rate : null;
    default:
      return null;
  }
}

interface TradeEffect {
  ticker: string;
  units: number;
  cash: number;
}

/** Units and cash a silo buy or sale moves; costs come out of cash. */
function tradeEffect(d: Decision, currency: Currency): TradeEffect | null {
  if (d.currency !== currency || d.ticker == null || d.price == null || d.amount == null) return null;
  const units = d.amount / d.price;
  if (d.type === "entry") return { ticker: d.ticker, units, cash: -(d.amount + (d.costs ?? 0)) };
  if (d.type === "exit") return { ticker: d.ticker, units: -units, cash: d.amount - (d.costs ?? 0) };
  return null;
}

export interface SiloDay {
  date: string;
  /** Cash + positions at the close. */
  value: number;
  /** Flows applied since the previous valuation. */
  flow: number;
}

export interface SiloHistory {
  /** State before the first measured day, valued the day before: the shadow's starting point. */
  base: { date: string; value: number };
  days: SiloDay[];
  flows: SiloFlow[];
  warnings: string[];
}

export interface SiloInput {
  currency: Currency;
  /** Today's state per portfolio.md. */
  portfolio: PortfolioSnapshot;
  decisions: readonly Decision[];
  /** First measured day (inclusive). */
  start: string;
  /** Last valuation: today. */
  asOf: string;
  /** Complete closes per symbol, the silo benchmark included. */
  bars: ReadonlyMap<string, HistoricalBar[]>;
  /** Silo benchmark: its sessions set the valuation dates. */
  reference: string;
}

/** Silo value on each session since `start`, rebuilt from portfolio.md and the log. */
export function reconstructSilo(input: SiloInput, m: Messages = messages()): SiloHistory {
  const { currency, portfolio, start, asOf, bars } = input;
  const events = input.decisions
    .filter((d) => d.date >= start && d.date <= asOf)
    .map((d) => ({ date: d.date, price: d.price, flow: flowAmount(d, currency), trade: tradeEffect(d, currency) }))
    .filter((e) => e.flow != null || e.trade != null)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Undo from today back to before the start.
  let cash = portfolio.totalCash ?? portfolio.cash;
  const units = new Map<string, number>(portfolio.positions.map((p) => [p.ticker, p.volume]));
  for (const e of events) {
    cash -= (e.flow ?? 0) + (e.trade?.cash ?? 0);
    if (e.trade) units.set(e.trade.ticker, (units.get(e.trade.ticker) ?? 0) - e.trade.units);
  }

  const warnings: string[] = [];
  if (cash < -CASH_EPSILON) {
    warnings.push(m.evaluation.siloWarnings.negativeCash(currency, start, cash.toFixed(2)));
  }
  for (const [ticker, u] of units) {
    if (u < -UNITS_EPSILON) {
      warnings.push(m.evaluation.siloWarnings.oversold(currency, ticker, u.toFixed(4), start));
    }
  }

  // Without an asset close (Yahoo fails or does not cover it), its last known price.
  const fallback = new Map<string, number>();
  for (const e of events) if (e.trade && e.price != null) fallback.set(e.trade.ticker, e.price);
  for (const p of portfolio.positions) fallback.set(p.ticker, p.currentPrice);
  const missing = new Set<string>();
  const valueAt = (date: string): number => {
    let value = cash;
    for (const [ticker, u] of units) {
      if (Math.abs(u) <= UNITS_EPSILON) continue;
      const close = closeOnOrBefore(bars.get(ticker) ?? [], date)?.close;
      if (close == null) missing.add(ticker);
      value += u * (close ?? fallback.get(ticker) ?? 0);
    }
    return value;
  };

  // The starting point is the day before the start, with each series' last
  // close, not the benchmark's previous session: if the benchmark misses a
  // session (holiday in its market or a Yahoo gap), the silo would start with
  // older closes than today's and what moved before the start would show up
  // as return and as drawdown.
  const base = { date: dayBefore(start), value: 0 };
  base.value = valueAt(base.date);
  const dates = (bars.get(input.reference) ?? []).map((b) => b.date).filter((d) => d >= start && d <= asOf);
  if (dates.at(-1) !== asOf) dates.push(asOf);

  const days: SiloDay[] = [];
  const flows: SiloFlow[] = [];
  let next = 0;
  for (const date of dates) {
    let flow = 0;
    for (; next < events.length && events[next].date <= date; next++) {
      const e = events[next];
      cash += (e.flow ?? 0) + (e.trade?.cash ?? 0);
      if (e.trade) units.set(e.trade.ticker, (units.get(e.trade.ticker) ?? 0) + e.trade.units);
      if (e.flow != null) {
        flow += e.flow;
        flows.push({ date: e.date, amount: e.flow });
      }
    }
    days.push({ date, value: valueAt(date), flow });
  }

  if (missing.size > 0) {
    warnings.push(m.evaluation.siloWarnings.missingCloses(currency, [...missing].join(", ")));
  }
  return { base, days, flows, warnings };
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface Drawdown {
  /** Current drawdown from the peak, in %. */
  currentPct: number;
  /** Largest drawdown of the period, in %. */
  maxPct: number;
  peakDate: string;
}

/**
 * Drawdown of the NAV net of flows (ADR-0009 §4): an index chaining each
 * session's return net of what came in or out that day. With the raw value,
 * the €50/week would mask the losses.
 */
export function drawdown(history: Pick<SiloHistory, "base" | "days">): Drawdown {
  let index = 1;
  let peak = 1;
  let peakDate = history.base.date;
  let maxPct = 0;
  let previous = history.base.value;
  for (const day of history.days) {
    // The flow comes in at the close: the day's return is that of the money already there.
    if (previous > CASH_EPSILON) index *= (day.value - day.flow) / previous;
    previous = day.value;
    if (index > peak) {
      peak = index;
      peakDate = day.date;
    }
    maxPct = Math.max(maxPct, (1 - index / peak) * 100);
  }
  return { currentPct: (1 - index / peak) * 100, maxPct, peakDate };
}

/**
 * Shadow portfolio value at `asOf` (ADR-0009 §1): it starts with the silo's
 * real value at the base close and replays each flow into the benchmark, at
 * the close of its date. `null` if a benchmark close is missing on any of
 * those dates.
 */
export function shadowValue(
  base: { date: string; value: number },
  flows: readonly SiloFlow[],
  referenceBars: HistoricalBar[],
  asOf: string,
): number | null {
  const closeAt = (date: string) => closeOnOrBefore(referenceBars, date)?.close;
  const start = closeAt(base.date);
  if (start == null) return null;
  let units = base.value / start;
  for (const f of flows) {
    const close = closeAt(f.date);
    if (close == null) return null;
    units += f.amount / close;
  }
  const end = closeAt(asOf);
  return end == null ? null : units * end;
}

/**
 * Money-weighted return (modified Dietz), in %: each flow is weighted by the
 * part of the period it was invested. `null` if the period has no days or
 * there was no capital to measure.
 */
export function moneyWeightedReturn(
  start: { date: string; value: number },
  end: { date: string; value: number },
  flows: readonly SiloFlow[],
): number | null {
  const days = daysBetween(start.date, end.date);
  if (days <= 0) return null;
  let net = 0;
  let weighted = 0;
  for (const f of flows) {
    net += f.amount;
    weighted += (f.amount * Math.max(0, days - daysBetween(start.date, f.date))) / days;
  }
  const capital = start.value + weighted;
  if (capital <= CASH_EPSILON) return null;
  return ((end.value - start.value - net) / capital) * 100;
}

export interface SiloPerformance {
  currency: Currency;
  reference: string;
  /** First measured day. */
  start: string;
  /** Real value today, rebuilt from portfolio.md. */
  real: number;
  /** Shadow portfolio value today; `null` without benchmark closes. */
  shadow: number | null;
  /** Money-weighted returns, in %. */
  realReturnPct: number | null;
  shadowReturnPct: number | null;
  drawdown: Drawdown;
  warnings: string[];
}

/** Real silo against its shadow, with the drawdown. */
export function siloPerformance(input: SiloInput, m: Messages = messages()): SiloPerformance {
  const history = reconstructSilo(input, m);
  const real = (history.days.at(-1) ?? history.base).value;
  const shadow = shadowValue(history.base, history.flows, input.bars.get(input.reference) ?? [], input.asOf);
  const warnings = [...history.warnings];
  if (shadow == null) warnings.push(m.evaluation.siloWarnings.noShadow(input.currency, input.reference));
  return {
    currency: input.currency,
    reference: input.reference,
    start: input.start,
    real,
    shadow,
    realReturnPct: moneyWeightedReturn(history.base, { date: input.asOf, value: real }, history.flows),
    shadowReturnPct:
      shadow == null ? null : moneyWeightedReturn(history.base, { date: input.asOf, value: shadow }, history.flows),
    drawdown: drawdown(history),
    warnings,
  };
}
