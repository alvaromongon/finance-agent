// Warning for an already crossed stop-loss (not "near the stop", but below it).
//
// Why it exists apart from the `approaching_stop` trigger:
//   `approaching_stop` escalates to analysis to decide what to do with a
//   position nearing its stop. When the price is ALREADY below, the question
//   is not one of analysis but of state: the broker may have filled the stop
//   and the engine has no way of knowing (the broker API was discontinued in
//   March 2025, portfolio.md is synced by hand). No market data frequency
//   solves that — only looking at the account.
//
//   That is why the warning goes straight to the heartbeat summary email,
//   without the reasoner: it spends no tokens, does not depend on the
//   re-analysis cooldown and goes out the same day the price crosses, instead
//   of waiting for the Monday Briefing. Without it, a position can trade below
//   its stop for days without anyone looking.
import type { Currency, Position } from "../types.js";
import type { Ticker } from "../ticker.js";

export interface StopBreach {
  ticker: Ticker;
  currency: Currency;
  /** Market price crossing the stop. */
  price: number;
  stopLoss: number;
  volume: number;
  /** How far the price is below the stop, in % of the stop. */
  belowStopPct: number;
  /** Unrealized P/L at market price, in case the stop did not fill. */
  unrealizedPl: number;
}

/**
 * Positions whose market price is below the recorded stop.
 * Positions without a stop (`stopLoss` null) or without a price are left out:
 * there is nothing to cross.
 */
export function detectStopBreaches(positions: Position[], prices: Map<string, number>): StopBreach[] {
  const breaches: StopBreach[] = [];

  for (const position of positions) {
    const { stopLoss } = position;
    if (stopLoss == null || stopLoss <= 0) continue;

    const price = prices.get(position.ticker);
    if (price == null || price >= stopLoss) continue;

    breaches.push({
      ticker: position.ticker,
      currency: position.currency,
      price,
      stopLoss,
      volume: position.volume,
      belowStopPct: ((stopLoss - price) / stopLoss) * 100,
      unrealizedPl: (price - position.avgPrice) * position.volume,
    });
  }

  return breaches;
}
