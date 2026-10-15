// Market data from saved files instead of the network: one JSON
// file per ticker, `<dir>/<TICKER>.json`, with the daily bars in date order.
// It powers the demo against examples/brain and lets anyone try the engine
// without network or a market data account. The requested range is ignored:
// the file is the whole history.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoricalBar, IMarketDataProvider } from "./types.js";

export class FixturesProvider implements IMarketDataProvider {
  constructor(private readonly dir: string) {}

  async getHistorical(ticker: string): Promise<HistoricalBar[]> {
    const raw = await readFile(join(this.dir, `${ticker}.json`), "utf8").catch(() => null);
    return raw ? (JSON.parse(raw) as HistoricalBar[]) : [];
  }

  async getPrices(tickers: string[]): Promise<Map<string, number>> {
    return this.lastCloses(tickers, 1);
  }

  async getPreviousCloses(tickers: string[]): Promise<Map<string, number>> {
    return this.lastCloses(tickers, 2);
  }

  /** The `back`-th close from the end of each ticker that has one. */
  private async lastCloses(tickers: string[], back: number): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const ticker of tickers) {
      const bars = await this.getHistorical(ticker);
      if (bars.length >= back) result.set(ticker, bars[bars.length - back].close);
    }
    return result;
  }
}
