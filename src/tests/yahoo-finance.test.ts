// Tests of the Yahoo Finance provider mocking global `fetch` (no real network).
// Focus: (1) quotes are requested in batches via `spark` within the 20-symbol
// limit, (2) the per-ticker cache avoids duplicate requests across
// getPrices/getPreviousCloses/fetchLastMarketDate, and (3) the `chart` fallback
// covers both a symbol spark does not return and a whole-batch failure.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { YahooFinanceProvider } from "../providers/yahoo-finance.js";

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];

const sparkCalls = () => fetchCalls.filter((u) => u.includes("/spark"));
const chartCalls = () => fetchCalls.filter((u) => u.includes("/chart"));

/** Symbols requested in the n-th spark call, in order. */
function symbolsOf(url: string): string[] {
  const raw = new URL(url).searchParams.get("symbols") ?? "";
  return raw.split(",").filter(Boolean);
}

function sparkEntry(overrides: Record<string, unknown> = {}) {
  return {
    close: [100],
    timestamp: [1_700_000_000],
    chartPreviousClose: 95,
    ...overrides,
  };
}

function chartResponse(overrides: Record<string, unknown> = {}) {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: 111,
            regularMarketTime: 1_700_000_500,
            chartPreviousClose: 105,
            ...overrides,
          },
        },
      ],
    },
  };
}

/**
 * Default mock: spark answers with one entry per requested symbol; chart
 * answers the fallback meta. `sparkBody` allows forcing partial answers or
 * batch errors.
 */
function installFetchMock(
  opts: {
    sparkBody?: (symbols: string[]) => unknown;
    sparkStatus?: number;
    chartBody?: unknown;
  } = {},
) {
  fetchCalls = [];
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    fetchCalls.push(u);

    if (u.includes("/spark")) {
      const status = opts.sparkStatus ?? 200;
      const symbols = symbolsOf(u);
      const body = opts.sparkBody?.(symbols) ?? Object.fromEntries(symbols.map((s) => [s, sparkEntry({ symbol: s })]));
      return new Response(JSON.stringify(body), { status });
    }

    return new Response(JSON.stringify(opts.chartBody ?? chartResponse()), { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  installFetchMock();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("YahooFinanceProvider — batch quotes (spark)", () => {
  it("getPrices reads the last spark close with a single request for several tickers", async () => {
    const provider = new YahooFinanceProvider(0);
    const prices = await provider.getPrices(["XOM", "VST", "MSFT"]);

    assert.equal(prices.get("XOM"), 100);
    assert.equal(prices.get("MSFT"), 100);
    assert.equal(sparkCalls().length, 1, "the 3 tickers fit in a single batch");
    assert.equal(chartCalls().length, 0, "no fallback: spark resolved them all");
  });

  it("getPrices takes the last non-null value of the close series", async () => {
    installFetchMock({
      sparkBody: (symbols) => Object.fromEntries(symbols.map((s) => [s, sparkEntry({ close: [98, 101, null] })])),
    });
    const provider = new YahooFinanceProvider(0);
    const prices = await provider.getPrices(["XOM"]);
    assert.equal(prices.get("XOM"), 101);
  });

  it("splits into batches of 20 symbols (endpoint limit)", async () => {
    const tickers = Array.from({ length: 45 }, (_, i) => `T${i}`);
    const provider = new YahooFinanceProvider(0);
    const prices = await provider.getPrices(tickers);

    assert.equal(prices.size, 45);
    assert.equal(sparkCalls().length, 3, "45 symbols -> 20 + 20 + 5");
    assert.deepEqual(
      sparkCalls().map((u) => symbolsOf(u).length),
      [20, 20, 5],
    );
  });

  it("getPreviousCloses reads chartPreviousClose", async () => {
    const provider = new YahooFinanceProvider(0);
    const closes = await provider.getPreviousCloses(["XOM"]);
    assert.equal(closes.get("XOM"), 95);
  });

  it("getPreviousCloses falls back to previousClose if there is no chartPreviousClose", async () => {
    installFetchMock({
      sparkBody: (symbols) =>
        Object.fromEntries(symbols.map((s) => [s, sparkEntry({ chartPreviousClose: null, previousClose: 93 })])),
    });
    const provider = new YahooFinanceProvider(0);
    const closes = await provider.getPreviousCloses(["XOM"]);
    assert.equal(closes.get("XOM"), 93);
  });

  it("fetchLastMarketDate reads regularMarketTime from chart, not the spark bar", async () => {
    // spark with interval=1d labels the bar with the session open; the session
    // guard needs the real last tick or it would lose the margin that lets it
    // tolerate delayed crons.
    const provider = new YahooFinanceProvider(0);
    const date = await provider.fetchLastMarketDate("XOM");

    assert.deepEqual(date, new Date(1_700_000_500 * 1000), "the timestamp comes from the chart meta");
    assert.equal(chartCalls().length, 1);
  });

  it("fetchLastMarketDate caches its lookup per ticker", async () => {
    const provider = new YahooFinanceProvider(0);
    await provider.fetchLastMarketDate("XOM");
    await provider.fetchLastMarketDate("XOM");
    assert.equal(chartCalls().length, 1, "the second call is a cache hit");
  });
});

describe("YahooFinanceProvider — per-ticker cache", () => {
  it("getPreviousCloses reuses the batch getPrices already requested: only 1 request for both", async () => {
    const provider = new YahooFinanceProvider(0);
    await provider.getPrices(["XOM", "VST"]);
    assert.equal(fetchCalls.length, 1, "getPrices made its single batch request");

    await provider.getPreviousCloses(["XOM", "VST"]);
    assert.equal(fetchCalls.length, 1, "getPreviousCloses must NOT repeat the request (cache hit)");
  });

  it("fetchLastMarketDate does not redo the quotes batch", async () => {
    const provider = new YahooFinanceProvider(0);
    await provider.getPrices(["XOM"]);
    await provider.fetchLastMarketDate("XOM");

    assert.equal(sparkCalls().length, 1, "the price batch is not repeated");
    assert.equal(chartCalls().length, 1, "only the session time lookup");
  });

  it("only requests the tickers missing from the cache", async () => {
    const provider = new YahooFinanceProvider(0);
    await provider.getPrices(["XOM"]);
    await provider.getPrices(["XOM", "VST"]);

    assert.equal(sparkCalls().length, 2);
    assert.deepEqual(symbolsOf(sparkCalls()[1]), ["VST"], "the second batch only requests the new ticker");
  });

  it("the cache is per instance: two different providers make their own request", async () => {
    const providerA = new YahooFinanceProvider(0);
    const providerB = new YahooFinanceProvider(0);
    await providerA.getPrices(["XOM"]);
    await providerB.getPrices(["XOM"]);
    assert.equal(fetchCalls.length, 2, "each instance must fetch once, without sharing the cache");
  });
});

describe("YahooFinanceProvider — fallback to chart", () => {
  it("a symbol spark does not return falls back to chart", async () => {
    installFetchMock({
      sparkBody: (symbols) =>
        Object.fromEntries(symbols.filter((s) => s !== "VST").map((s) => [s, sparkEntry({ symbol: s })])),
    });
    const provider = new YahooFinanceProvider(0);
    const prices = await provider.getPrices(["XOM", "VST"]);

    assert.equal(prices.get("XOM"), 100, "the one that came from spark keeps its price");
    assert.equal(prices.get("VST"), 111, "the missing one is resolved through chart");
    assert.equal(chartCalls().length, 1, "only the missing symbol uses chart");
  });

  it("if the whole batch fails (HTTP), every symbol falls back to chart", async () => {
    installFetchMock({ sparkStatus: 500 });
    const provider = new YahooFinanceProvider(0);
    const prices = await provider.getPrices(["XOM", "VST"]);

    assert.equal(prices.get("XOM"), 111);
    assert.equal(prices.get("VST"), 111);
    assert.equal(chartCalls().length, 2);
  });

  it("a spark business error (too many symbols) also falls back to chart", async () => {
    installFetchMock({
      sparkBody: () => ({
        spark: {
          result: null,
          error: { code: "Bad Request", description: "Number of symbols needs to be less than or equal to 20" },
        },
      }),
    });
    const provider = new YahooFinanceProvider(0);
    const prices = await provider.getPrices(["XOM"]);

    assert.equal(prices.get("XOM"), 111);
    assert.equal(chartCalls().length, 1);
  });

  it("a ticker that resolves through neither path is not requested again in the same run", async () => {
    installFetchMock({
      sparkBody: () => ({}),
      chartBody: { chart: { result: [] } },
    });
    const provider = new YahooFinanceProvider(0);
    const prices = await provider.getPrices(["NOPE"]);
    assert.equal(prices.has("NOPE"), false);

    const callsAfterFirst = fetchCalls.length;
    await provider.getPreviousCloses(["NOPE"]);
    assert.equal(fetchCalls.length, callsAfterFirst, "the failure is cached, not retried");
  });
});

describe("YahooFinanceProvider — history (chart)", () => {
  const openAt = (date: string) => Date.parse(`${date}T13:30:00Z`) / 1000;
  const HISTORY = {
    chart: {
      result: [
        {
          timestamp: [openAt("2026-07-01"), openAt("2026-07-02"), openAt("2026-07-03")],
          indicators: {
            quote: [{ close: [10, null, 12], high: [11, 11, 13], low: [9, 9, 11], volume: [5000, 4000, null] }],
          },
        },
      ],
    },
  };

  /** fetch that answers with the given statuses, in order; the last one repeats. */
  function installStatusSequence(statuses: number[]) {
    fetchCalls = [];
    globalThis.fetch = (async (url: string) => {
      fetchCalls.push(String(url));
      const status = statuses[Math.min(fetchCalls.length - 1, statuses.length - 1)];
      return new Response(status === 200 ? JSON.stringify(HISTORY) : "", { status });
    }) as typeof fetch;
  }

  it("returns the daily bars with the requested range, skipping days without a close", async () => {
    installStatusSequence([200]);
    const bars = await new YahooFinanceProvider(0, 0).getHistorical("XOM", "2y");

    assert.deepEqual(
      bars.map((b) => b.date),
      ["2026-07-01", "2026-07-03"],
    );
    assert.match(fetchCalls[0], /range=2y/);
  });

  it("reads each session's volume and omits it if Yahoo does not provide it (liquidity filter)", async () => {
    installStatusSequence([200]);
    const bars = await new YahooFinanceProvider(0, 0).getHistorical("XOM", "1y");

    assert.equal(bars[0].volume, 5000);
    assert.ok(!("volume" in bars[1]), "without volume a 0 is not made up");
  });

  it("retries on 429 and returns the series (a long download does not lose the symbol)", async () => {
    installStatusSequence([429, 200]);
    const bars = await new YahooFinanceProvider(0, 0).getHistorical("XOM");

    assert.equal(bars.length, 2);
    assert.equal(fetchCalls.length, 2);
  });

  it("persistent 429: throws after exhausting the 3 attempts", async () => {
    installStatusSequence([429]);
    await assert.rejects(() => new YahooFinanceProvider(0, 0).getHistorical("XOM"), /HTTP 429/);
    assert.equal(fetchCalls.length, 3);
  });

  it("an HTTP error other than 429 is not retried", async () => {
    installStatusSequence([500]);
    await assert.rejects(() => new YahooFinanceProvider(0, 0).getHistorical("XOM"), /HTTP 500/);
    assert.equal(fetchCalls.length, 1);
  });
});
