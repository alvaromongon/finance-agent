// Price of each silo's benchmark (ADR-0009 §1) for the decision log (issue
//), and its market regime. Best-effort by design: the
// benchmark is a snapshot to measure later, and losing it must never cost
// recording the decision or an alert. Whoever measures it can recover
// that date's close.
import { config } from "../config.js";
import { classifyRegime } from "./market-regime.js";
import type { HistoricalBar } from "../providers/types.js";
import type { Benchmark, Currency } from "../types.js";

export interface PriceSource {
  getPrices(tickers: string[]): Promise<Map<string, number>>;
  getHistorical?(ticker: string, range?: string): Promise<HistoricalBar[]>;
}

/**
 * Current benchmark price for each requested currency and, if the provider
 * gives history, its regime. Without a price, the currency is
 * left out; without enough history, the benchmark has no regime.
 */
export async function fetchBenchmarks(
  provider: PriceSource,
  currencies: readonly Currency[],
  log: (msg: string) => void = console.warn,
): Promise<Partial<Record<Currency, Benchmark>>> {
  const tickers = currencies.map((c) => config.reference[c]);
  const result: Partial<Record<Currency, Benchmark>> = {};
  try {
    const prices = await provider.getPrices(tickers);
    for (const currency of currencies) {
      const ticker = config.reference[currency];
      const price = prices.get(ticker);
      if (price == null || !(price > 0)) continue;
      const regime = await regimeOf(provider, ticker, price, log);
      result[currency] = regime ? { ticker, price, regime } : { ticker, price };
    }
  } catch (err) {
    log(`[benchmark] no benchmark price (${err instanceof Error ? err.message : String(err)})`);
  }
  return result;
}

async function regimeOf(provider: PriceSource, ticker: string, price: number, log: (msg: string) => void) {
  if (!provider.getHistorical) return null;
  try {
    const bars = await provider.getHistorical(ticker, "1y");
    return classifyRegime(
      bars.map((b) => b.close),
      price,
    );
  } catch (err) {
    log(`[benchmark] no regime for ${ticker} (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

/**
 * A silo's benchmark on a given date: the current price if it is today, or
 * the last close on or before that date if earlier (the owner may narrate
 * yesterday's trade, or a Saturday conversion). `undefined` if the history
 * does not reach that date or the provider fails.
 */
export async function benchmarkOnDate(
  provider: PriceSource,
  currency: Currency,
  date: string,
  today = new Date().toISOString().slice(0, 10),
  log: (msg: string) => void = console.warn,
): Promise<Benchmark | undefined> {
  if (date >= today) return (await fetchBenchmarks(provider, [currency], log))[currency];

  const ticker = config.reference[currency];
  try {
    const bars = (await provider.getHistorical?.(ticker, "6mo")) ?? [];
    // Bars in chronological order: the last one not past the date.
    const bar = bars.filter((b) => b.date <= date).at(-1);
    return bar ? { ticker, price: bar.close } : undefined;
  } catch (err) {
    log(`[benchmark] no ${ticker} close on ${date} (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}
