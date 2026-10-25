// Volatility-sized stops: multiples of ATR14, not a fixed percentage of the
// price.
//
// Why: a 3% stop does not mean the same in two different assets. In a large
// cap with ATR14 ≈ 1.9% of the price it is 1.5 ATR —within the noise of a bad
// session—; in a volatile stock with ATR14 ≈ 4.8% it is 0.6 ATR, i.e. almost
// certainly swept. The textbook case: a stop 1.2 ATR from the price fires in a
// macro drop and the stock **closes above the stop itself**. Noise takes the
// position out, not a deteriorating thesis.
//
// The stop distance is therefore expressed in ATR: how many typical sessions
// of adverse movement fit before it fires. Below MIN_STOP_ATR the stop does not
// protect a thesis, it only guarantees the exit.
import type { Currency, Horizon, Position } from "../types.js";
import { atr14d } from "./technicals.js";
import type { HistoricalBar } from "../providers/types.js";
import type { Ticker } from "../ticker.js";

/**
 * Minimum below which a stop is considered tight: noise will hit it before
 * the thesis does. It is the heartbeat warning threshold, not a target.
 */
export const MIN_STOP_ATR = 2;

/**
 * Distance when opening or adjusting a stop, per horizon: the longer the
 * horizon, the more noise to tolerate without exiting. It is
 * the stop of the ticket the engine computes (`utils/sizing.ts`); the owner
 * still sets the real stop at their broker, and the heartbeat warning checks
 * it does not fall below MIN_STOP_ATR.
 */
export const STOP_ATR_BY_HORIZON: Record<Horizon, number> = { short: 2.5, medium: 3 };

/** Stop distance in multiples of ATR. `null` if the ATR is not usable. */
export function atrMultiple(price: number, stopLoss: number, atr: number | null): number | null {
  if (atr == null || atr <= 0 || !Number.isFinite(atr)) return null;
  return (price - stopLoss) / atr;
}

/** Suggested stop: `price` minus the horizon's reference distance. */
export function suggestStop(price: number, atr: number, horizon: Horizon = "medium"): number {
  return Math.round((price - STOP_ATR_BY_HORIZON[horizon] * atr) * 100) / 100;
}

/**
 * Trailing stop: raises the stop to the horizon's reference
 * distance below today's price, and never lowers it. `null` if the current
 * stop is already at that height or higher: nothing to adjust.
 */
export function trailingStop(
  price: number,
  atr: number,
  currentStop: number | null,
  horizon: Horizon = "medium",
): number | null {
  const candidate = suggestStop(price, atr, horizon);
  if (currentStop != null && candidate <= currentStop) return null;
  return candidate;
}

/** A position whose stop is closer to the price than its volatility tolerates. */
export interface TightStop {
  ticker: Ticker;
  currency: Currency;
  price: number;
  stopLoss: number;
  /** ATR14 in price units. */
  atr: number;
  /** Current stop distance, in ATR. */
  multiple: number;
  /** Current stop distance, in % of the price (to read next to ATR%). */
  distancePct: number;
  /** ATR14 as % of the price: the volatility the stop should absorb. */
  atrPct: number;
  /** Stop that would leave the reference distance (`medium` horizon). */
  suggestedStop: number;
  /** true if the suggested stop falls below the average buy price. */
  suggestedBelowEntry: boolean;
  avgPrice: number;
}

/**
 * Positions with an active stop less than `minAtr` ATR from the market price.
 *
 * Left out: those without a stop (nothing to evaluate), those already trading
 * below it (`detectStopBreaches` covers that and the question there is
 * another: whether the broker already filled it) and those whose ATR could
 * not be computed.
 */
export function detectTightStops(
  positions: Position[],
  prices: Map<string, number>,
  atrByTicker: Map<string, number>,
  minAtr = MIN_STOP_ATR,
): TightStop[] {
  const tight: TightStop[] = [];

  for (const position of positions) {
    const { stopLoss } = position;
    if (stopLoss == null || stopLoss <= 0) continue;

    const price = prices.get(position.ticker);
    if (price == null || price <= stopLoss) continue;

    const atr = atrByTicker.get(position.ticker);
    const multiple = atrMultiple(price, stopLoss, atr ?? null);
    if (atr == null || multiple == null || multiple >= minAtr) continue;

    const suggestedStop = suggestStop(price, atr);
    tight.push({
      ticker: position.ticker,
      currency: position.currency,
      price,
      stopLoss,
      atr,
      multiple,
      distancePct: ((price - stopLoss) / price) * 100,
      atrPct: (atr / price) * 100,
      suggestedStop,
      suggestedBelowEntry: suggestedStop < position.avgPrice,
      avgPrice: position.avgPrice,
    });
  }

  return tight;
}

/** Injectable history source (same optional contract as `strength.ts`). */
export interface HistoricalSource {
  getHistorical?(ticker: string, range?: string): Promise<HistoricalBar[]>;
}

/**
 * ATR14 of the positions with an active stop, for the heartbeat warning.
 *
 * Best-effort and bounded by design: it only downloads history for open
 * positions with a stop (0-3 per silo today), never the whole watchlist, and a
 * provider failure leaves the ticker without ATR instead of aborting the run.
 * The heartbeat is still the cheap layer: a hygiene warning must not cost a
 * risk alert.
 */
export async function fetchAtrForPositions(
  positions: Position[],
  provider: HistoricalSource,
  log: (msg: string) => void = console.warn,
): Promise<Map<string, number>> {
  const atrByTicker = new Map<string, number>();
  if (!provider.getHistorical) return atrByTicker;

  for (const position of positions) {
    if (position.stopLoss == null || position.stopLoss <= 0) continue;
    try {
      const bars = await provider.getHistorical(position.ticker, "1y");
      const atr = atr14d(bars);
      if (atr != null && atr > 0) atrByTicker.set(position.ticker, atr);
    } catch (err) {
      log(
        `[finance-agent] ${position.ticker}: no ATR to review the stop (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  return atrByTicker;
}
