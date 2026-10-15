// Cheap filter (no LLM): the risk triggers of everything watched. The
// candidates' entry setups live in utils/setups/ (ADR-0013). See
// routines/daily-heartbeat.md and strategies/base.md.
import { config } from "./config.js";
import { siloValue } from "./utils/sizing.js";
import type { PortfolioSnapshot, Position, Signal, TriggerKind, WatchlistEntry } from "./types.js";

/**
 * Union of tickers to watch: watchlist ∪ portfolio.positions, deduplicated by
 * ticker (ADR-0007). portfolio.md is the source of truth for which
 * positions to watch for risk, whether or not they have a watchlist.md entry.
 * Stable order: watchlist first (in its order), then positions without a
 * watchlist entry.
 */
export function collectWatchedTickers(watchlist: WatchlistEntry[], portfolio: PortfolioSnapshot): string[] {
  const seen = new Set<string>();
  const tickers: string[] = [];
  for (const entry of watchlist) {
    if (seen.has(entry.ticker)) continue;
    seen.add(entry.ticker);
    tickers.push(entry.ticker);
  }
  for (const position of portfolio.positions) {
    if (seen.has(position.ticker)) continue;
    seen.add(position.ticker);
    tickers.push(position.ticker);
  }
  return tickers;
}

/**
 * Risk triggers of a watched ticker: `approaching_stop` if it has a position
 * with a stop and the price is less than `stopProximityPct` above it;
 * `big_move` if the change against the previous close reaches `bigMovePct`.
 */
export function riskTriggers(input: {
  price: number;
  position?: Position;
  previousClose?: number;
  stopProximityPct: number;
  bigMovePct: number;
}): TriggerKind[] {
  const { price, position, previousClose, stopProximityPct, bigMovePct } = input;
  const triggers: TriggerKind[] = [];
  if (position?.stopLoss != null && price <= position.stopLoss * (1 + stopProximityPct / 100)) {
    triggers.push("approaching_stop");
  }
  if (
    previousClose != null &&
    previousClose > 0 &&
    (Math.abs(price - previousClose) / previousClose) * 100 >= bigMovePct
  ) {
    triggers.push("big_move");
  }
  return triggers;
}

/**
 * Risk signals for the union watchlist ∪ portfolio.positions (see
 * collectWatchedTickers): the assets that fire ≥1 risk trigger.
 * `stopProximityPct`/`bigMovePct` can be injected in tests; production uses the config.
 */
export function evaluateSignals(
  watchlist: WatchlistEntry[],
  portfolio: PortfolioSnapshot,
  prices: Map<string, number>,
  stopProximityPct = config.strategy.stopProximityPct,
  previousCloses = new Map<string, number>(),
  bigMovePct = config.strategy.bigMovePct,
): Signal[] {
  const signals: Signal[] = [];
  const watchlistByTicker = new Map(watchlist.map((entry) => [entry.ticker, entry]));
  // Base of the risk sizing, with this run's prices.
  const silo = siloValue(portfolio, prices);

  for (const ticker of collectWatchedTickers(watchlist, portfolio)) {
    const price = prices.get(ticker);
    if (price == null) continue;

    const entry = watchlistByTicker.get(ticker);
    const position = portfolio.positions.find((p) => p.ticker === ticker);
    const triggers = riskTriggers({
      price,
      position,
      previousClose: previousCloses.get(ticker),
      stopProximityPct,
      bigMovePct,
    });

    if (triggers.length > 0) {
      const currency = entry?.currency ?? position?.currency ?? portfolio.currency;
      signals.push({ ticker, currency, triggers, price, entry, position, cash: portfolio.cash, siloValue: silo });
    }
  }

  return signals;
}
