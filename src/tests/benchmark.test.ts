/**
 * Tests of utils/benchmark.ts: the silo benchmark is best-effort
 * and, on a past date, the last known close. No network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { benchmarkOnDate, fetchBenchmarks } from "../utils/benchmark.js";
import type { HistoricalBar } from "../providers/types.js";

const bar = (date: string, close: number): HistoricalBar => ({ date, close, high: close + 1, low: close - 1 });

// Thursday 10, Friday 11 and Monday 14 September: the weekend has no session.
const provider = {
  getPrices: async (tickers: string[]) => new Map(tickers.map((t) => [t, 130])),
  getHistorical: async () => [bar("2026-09-10", 126), bar("2026-09-11", 127), bar("2026-09-14", 128)],
};
const quiet = () => {};

describe("benchmarkOnDate", () => {
  it("today: current price of the silo benchmark", async () => {
    assert.deepEqual(await benchmarkOnDate(provider, "USD", "2026-09-15", "2026-09-15", quiet), {
      ticker: "VOO",
      price: 130,
    });
  });

  it("past date with a session: its close", async () => {
    assert.deepEqual(await benchmarkOnDate(provider, "EUR", "2026-09-14", "2026-09-15", quiet), {
      ticker: "EXSA.DE",
      price: 128,
    });
  });

  // A trade narrated days later is recorded with that day's close
  // but without a regime — the regime belongs to the present and is not rebuilt
  // backwards. It blocks nothing: `decision:record` records what was already done.
  it("past date: close without a regime, even with plenty of history", async () => {
    const year = Array.from({ length: 250 }, (_, i) => bar(`2026-09-${String((i % 28) + 1).padStart(2, "0")}`, 200));
    const withHistory = { ...provider, getHistorical: async () => year };
    const past = await benchmarkOnDate(withHistory, "USD", "2026-09-14", "2026-09-15", quiet);
    assert.equal(past?.regime, undefined);
  });

  it("date without a session (Sunday): the last previous close", async () => {
    assert.deepEqual(await benchmarkOnDate(provider, "EUR", "2026-09-13", "2026-09-15", quiet), {
      ticker: "EXSA.DE",
      price: 127,
    });
  });

  it("before the history or with the provider down: no benchmark", async () => {
    assert.equal(await benchmarkOnDate(provider, "EUR", "2026-01-02", "2026-09-15", quiet), undefined);

    const broken = {
      ...provider,
      getHistorical: async (): Promise<HistoricalBar[]> => {
        throw new Error("timeout");
      },
    };
    const logged: string[] = [];
    assert.equal(await benchmarkOnDate(broken, "EUR", "2026-09-11", "2026-09-15", (m) => logged.push(m)), undefined);
    assert.match(logged[0], /timeout/);
  });
});

describe("fetchBenchmarks", () => {
  it("with a year of history adds the silo regime; without it, only the price", async () => {
    const year = Array.from({ length: 250 }, (_, i) => bar(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, 200));
    const withHistory = { ...provider, getHistorical: async () => year };
    assert.deepEqual(await fetchBenchmarks(withHistory, ["USD"], quiet), {
      USD: { ticker: "VOO", price: 130, regime: "adverso" },
    });

    const logged: string[] = [];
    const broken = {
      ...provider,
      getHistorical: async (): Promise<HistoricalBar[]> => {
        throw new Error("429");
      },
    };
    assert.deepEqual(await fetchBenchmarks(broken, ["USD"], (m) => logged.push(m)), {
      USD: { ticker: "VOO", price: 130 },
    });
    assert.match(logged[0], /no regime for VOO \(429\)/);
  });

  it("skips the currency without a price and does not throw if the provider fails", async () => {
    const partial = { getPrices: async () => new Map([["VOO", 700]]) };
    assert.deepEqual(await fetchBenchmarks(partial, ["EUR", "USD"], quiet), { USD: { ticker: "VOO", price: 700 } });

    const down = {
      getPrices: async (): Promise<Map<string, number>> => {
        throw new Error("503");
      },
    };
    assert.deepEqual(await fetchBenchmarks(down, ["EUR"], quiet), {});
  });
});
