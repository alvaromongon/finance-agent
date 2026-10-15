// Contract of the market data layer.
// Any provider (Yahoo Finance, Polygon.io, IBKR...) must implement this
// interface. Business logic (heartbeat, etc.) only depends on this, never on
// the concrete provider.

export interface MarketPrice {
  ticker: string;
  price: number;
  currency: string;
  timestamp: string; // ISO 8601
}

/** One daily bar of price history. */
export interface HistoricalBar {
  date: string; // YYYY-MM-DD
  close: number;
  high: number;
  low: number;
  /** Shares traded in the session; absent if the provider does not give it (liquidity filter). */
  volume?: number;
}

/**
 * Market data provider.
 * - getPrices: current prices (used by the heartbeat). Required.
 * - getHistorical: daily historical series (used by the analyzer). Optional;
 *   a provider without history simply does not implement it.
 * - getPreviousCloses: previous session close (big_move trigger).
 *   Optional; without it, big_move is simply not evaluated.
 */
export interface IMarketDataProvider {
  getPrices(tickers: string[]): Promise<Map<string, number>>;
  getHistorical?(ticker: string, range?: string): Promise<HistoricalBar[]>;
  getPreviousCloses?(tickers: string[]): Promise<Map<string, number>>;
}
