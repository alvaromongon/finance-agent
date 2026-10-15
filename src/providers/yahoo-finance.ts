// Price provider via Yahoo Finance, using the public endpoints `spark`
// (batch quotes) and `chart` (historical series and fallback).
// No API key, no cost, global coverage (EU + US).
//
// Why `spark` for quotes:
//   It accepts up to 20 symbols per request (the endpoint itself says so:
//   "Number of symbols needs to be less than or equal to 20"), needs no crumb
//   or cookie, and returns the two data points the heartbeat needs: last
//   price (`close`) and previous close (`chartPreviousClose`). With ~30
//   watched tickers the run goes from ~30 requests to 2 — less latency and,
//   above all, far less 429 exposure from GitHub Actions datacenter IPs. The
//   last tick time is NOT read from here: see fetchLastMarketDate.
//
// Why we do NOT use yahoo-finance2 / the `quote` endpoint:
//   v7/finance/quote (the "classic" batch) answers 401 Unauthorized even with
//   a crumb from a clean IP; it required crumb + cookie and kept returning 429
//   from server IPs. `spark` and `chart` need nothing.
//
// European tickers carry the exchange suffix (SAP.DE, AIR.PA); US ones do not (KO). FX: EURUSD=X.
// Note: Yahoo is an unofficial service; it can change without notice. That is
// why `spark` falls back to `chart` ticker by ticker if it fails or a symbol
// is missing from the response: the heartbeat never runs out of prices
// because of a format change in the batch endpoint. The IMarketDataProvider
// abstraction allows replacing it with an API-key provider without touching
// business logic.
import type { HistoricalBar, IMarketDataProvider } from "./types.js";

const CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const SPARK_BASE = "https://query1.finance.yahoo.com/v8/finance/spark";
// Endpoint limit: asking for 21 or more returns HTTP 400.
const SPARK_MAX_SYMBOLS = 20;
// Browser UA: Yahoo rejects requests without a realistic User-Agent.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " + "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits a list into groups of `size` items (last group shorter). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Last non-null value of a series (Yahoo interleaves nulls in stretches without ticks). */
function lastNonNull(values: (number | null)[] | undefined): number | null {
  if (!values) return null;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null) return v;
  }
  return null;
}

/** Normalized quote, whether from `spark` or the `chart` fallback. */
interface Quote {
  price: number | null;
  previousClose: number | null;
}

const EMPTY_QUOTE: Quote = { price: null, previousClose: null };

interface SparkEntry {
  symbol?: string;
  close?: (number | null)[];
  timestamp?: number[];
  chartPreviousClose?: number | null;
  previousClose?: number | null;
}

interface ChartResult {
  meta?: {
    regularMarketPrice?: number | null;
    regularMarketTime?: number | null;
    chartPreviousClose?: number | null;
    previousClose?: number | null;
  };
  timestamp?: number[];
  indicators?: {
    quote?: {
      close?: (number | null)[];
      high?: (number | null)[];
      low?: (number | null)[];
      volume?: (number | null)[];
    }[];
  };
}

interface ChartResponse {
  chart?: {
    result?: ChartResult[] | null;
    error?: unknown;
  };
}

export class YahooFinanceProvider implements IMarketDataProvider {
  // Caches the quote per ticker for the lifetime of this instance (one per
  // run: see providers/factory.ts). getPrices, getPreviousCloses and
  // fetchLastMarketDate read from the same cache, so a single batch request
  // serves all three — it avoids duplicate Yahoo calls (and their 429 risk)
  // when a run asks for several.
  private quoteCache = new Map<string, Quote>();
  // Last tick time per ticker, cached separately because it comes from
  // `chart` (see fetchLastMarketDate) and not from the `spark` batch.
  private marketTimeCache = new Map<string, number | null>();

  /**
   * `rateLimitDelayMs` (pause after each request) and `retryBaseMs` (429
   * backoff base) are injectable so tests avoid real waits; production uses
   * the defaults.
   */
  constructor(
    private rateLimitDelayMs = 250,
    private retryBaseMs = 1000,
  ) {}

  async getPrices(tickers: string[]): Promise<Map<string, number>> {
    await this.loadQuotes(tickers);

    const prices = new Map<string, number>();
    for (const ticker of tickers) {
      const price = this.quoteCache.get(ticker)?.price;
      if (price != null) prices.set(ticker, price);
      else console.warn(`[providers/yahoo] No price for ${ticker}`);
    }
    return prices;
  }

  /** Previous session close per ticker (big_move trigger). */
  async getPreviousCloses(tickers: string[]): Promise<Map<string, number>> {
    await this.loadQuotes(tickers);

    const closes = new Map<string, number>();
    for (const ticker of tickers) {
      const close = this.quoteCache.get(ticker)?.previousClose;
      if (close != null) closes.set(ticker, close);
      else console.warn(`[providers/yahoo] No previousClose for ${ticker}`);
    }
    return closes;
  }

  /**
   * Returns the last market tick time according to Yahoo Finance.
   * The index.ts session guard uses it to detect holidays.
   *
   * It goes through `chart` (meta.regularMarketTime) and not the `spark`
   * batch: with `interval=1d`, spark labels the bar with the session OPEN, not
   * the last tick — in the US that is ~6.5h of fake age, which would eat the
   * margin the guard needs to tolerate delayed crons.
   * It is one request per run, on top of the 2 of the batch.
   */
  async fetchLastMarketDate(ticker: string): Promise<Date | null> {
    if (!this.marketTimeCache.has(ticker)) {
      const meta = await this.fetchMeta(ticker).catch((err) => {
        console.warn(
          `[providers/yahoo] Error fetching the session time of ${ticker}:`,
          err instanceof Error ? err.message : err,
        );
        return undefined;
      });
      this.marketTimeCache.set(ticker, meta?.regularMarketTime ?? null);
    }
    const ts = this.marketTimeCache.get(ticker);
    return ts != null ? new Date(ts * 1000) : null;
  }

  /**
   * Fills the quote cache for the missing tickers, in batches of
   * SPARK_MAX_SYMBOLS. Symbols `spark` does not return (or the whole batch if
   * the request fails) fall back to `chart`, one by one. Those that do not
   * resolve there either are cached empty: without that, a nonexistent ticker
   * would be requested again on every call of the same run.
   */
  private async loadQuotes(tickers: string[]): Promise<void> {
    const missing = [...new Set(tickers)].filter((t) => !this.quoteCache.has(t));
    if (missing.length === 0) return;

    const unresolved: string[] = [];

    for (const group of chunk(missing, SPARK_MAX_SYMBOLS)) {
      try {
        const entries = await this.fetchSpark(group);
        for (const ticker of group) {
          const entry = entries[ticker];
          if (!entry) {
            unresolved.push(ticker);
            continue;
          }
          this.quoteCache.set(ticker, {
            price: lastNonNull(entry.close),
            previousClose: entry.chartPreviousClose ?? entry.previousClose ?? null,
          });
        }
      } catch (err) {
        console.warn(
          `[providers/yahoo] spark failed for ${group.length} symbol(s), using chart:`,
          err instanceof Error ? err.message : err,
        );
        unresolved.push(...group);
      }
    }

    for (const ticker of unresolved) {
      try {
        const meta = await this.fetchMeta(ticker);
        this.quoteCache.set(ticker, {
          price: meta?.regularMarketPrice ?? null,
          previousClose: meta?.chartPreviousClose ?? meta?.previousClose ?? null,
        });
      } catch (err) {
        console.warn(`[providers/yahoo] Error fetching ${ticker}:`, err instanceof Error ? err.message : err);
        this.quoteCache.set(ticker, EMPTY_QUOTE);
      }
    }
  }

  /** One `spark` request per batch (≤ SPARK_MAX_SYMBOLS), retrying on 429. */
  private async fetchSpark(tickers: string[], attempts = 3): Promise<Record<string, SparkEntry>> {
    const symbols = tickers.map((t) => encodeURIComponent(t)).join(",");
    const url = `${SPARK_BASE}?symbols=${symbols}&range=1d&interval=1d`;

    try {
      for (let i = 0; i < attempts; i++) {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

        if (res.status === 429 && i < attempts - 1) {
          const wait = this.retryBaseMs * 2 ** i; // 1s, 2s, 4s
          console.warn(`[providers/yahoo] 429 on spark, retrying in ${wait}ms...`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

        // OK response: map { TICKER: {...} }. A business error (e.g. too many
        // symbols) arrives as { spark: { error: {...} } }.
        const data = (await res.json()) as Record<string, SparkEntry> & {
          spark?: { error?: { description?: string } | null };
        };
        const sparkError = data.spark?.error;
        if (sparkError) throw new Error(sparkError.description ?? "spark error");
        return data;
      }
      throw new Error("persistent 429 after retries");
    } finally {
      await sleep(this.rateLimitDelayMs);
    }
  }

  /** Per-ticker fallback via the `chart` endpoint: quote meta. */
  private async fetchMeta(ticker: string): Promise<ChartResult["meta"] | undefined> {
    const data = await this.fetchChart(`${CHART_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=1d`, ticker);
    return data?.chart?.result?.[0]?.meta;
  }

  /**
   * One `chart` request with exponential retry on 429. The rate-limit pause
   * always applies because this is only reached after a real network request.
   * Shared by the quote fallback and the history: without retries in the
   * history, a 429 in the middle of a long download (screening:outcomes asks
   * for ~100 series in a row) left that symbol without data.
   */
  private async fetchChart(url: string, label: string, attempts = 3): Promise<ChartResponse | undefined> {
    try {
      for (let i = 0; i < attempts; i++) {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

        if (res.status === 429 && i < attempts - 1) {
          const wait = this.retryBaseMs * 2 ** i; // 1s, 2s, 4s
          console.warn(`[providers/yahoo] 429 on ${label}, retrying in ${wait}ms...`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

        return (await res.json()) as ChartResponse;
      }
      return undefined;
    } finally {
      await sleep(this.rateLimitDelayMs);
    }
  }

  /** Daily historical series via the `chart` endpoint (range e.g. "1y", "2y"), retrying on 429. */
  async getHistorical(ticker: string, range = "1y"): Promise<HistoricalBar[]> {
    const data = await this.fetchChart(
      `${CHART_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=${range}`,
      ticker,
    );
    const result = data?.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0];
    if (!q) return [];

    const bars: HistoricalBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      if (close == null || high == null || low == null) continue; // skip days without data
      const volume = q.volume?.[i];
      bars.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        close,
        high,
        low,
        ...(volume != null ? { volume } : {}),
      });
    }
    return bars;
  }
}
