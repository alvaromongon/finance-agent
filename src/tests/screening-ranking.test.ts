/**
 * Tests of the screening universe ranking (ADR-0012): each filter 0
 * condition, the two factors, the score, the selection with exploration and
 * the cases where the ranking is not reliable. Fixtures, no network.
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HistoricalBar } from "../providers/types.js";
import {
  drawWithFilterZero,
  filterZero,
  historyLoader,
  medianTurnover,
  percentileRanks,
  proximityTo52wHigh,
  rankUniverse,
  relativeStrength,
  scoreSilo,
  selectFromRanking,
  type RankableTicker,
  type ScreeningRules,
  type UniverseRanking,
} from "../screening-ranking.js";
import { closes, weekdayBars } from "./fixtures/weekday-bars.js";

const RULES: ScreeningRules = {
  minSessions: 240,
  minMedianTurnover: 500_000,
  turnoverSessions: 50,
  maxStaleDays: 5,
  relativeStrengthSessions: 126,
  rankedBySilo: { EUR: 2, USD: 2 },
  explorationBySilo: 1,
  fallbackDraw: { eur: 1, usd: 2, commodities: 0 },
};

/** 252 sessions ending on 2026-09-11 (Friday), with volume (`null`, without it). */
const START = "2025-09-25";
const TODAY = "2026-09-12";
function series(closeAt: (i: number) => number, volume: number | null = 10_000): HistoricalBar[] {
  return weekdayBars(START, closes(252, closeAt)).map((b) => (volume == null ? b : { ...b, volume }));
}

const rising = series((i) => 100 + i * 0.25);
const flat = series(() => 100);

describe("filterZero", () => {
  it("eligible with a year of history, price above the SMA200 and liquidity", () => {
    assert.equal(filterZero(rising, TODAY, RULES), null);
  });

  it("last session more than 5 days ago: stale (suspended security or ticker not updated)", () => {
    assert.equal(filterZero(rising, "2026-09-16", RULES), null, "5 days: still valid");
    assert.equal(filterZero(rising, "2026-09-17", RULES), "stale");
    assert.equal(filterZero(rising.slice(-9), "2026-09-17", RULES), "stale", "checked before the history");
  });

  it("without bars: no_data; with less than a year: short_history (the BBVA.MC case with 9 sessions)", () => {
    assert.equal(filterZero([], TODAY, RULES), "no_data");
    assert.equal(filterZero(rising.slice(-9), TODAY, RULES), "short_history");
    assert.equal(filterZero(rising.slice(-239), TODAY, RULES), "short_history");
  });

  it("price at or below the SMA200: below_sma200 (also covers the BAJISTA bias)", () => {
    assert.equal(
      filterZero(
        series((i) => 200 - i * 0.25),
        TODAY,
        RULES,
      ),
      "below_sma200",
    );
    assert.equal(filterZero(flat, TODAY, RULES), "below_sma200", "at the SMA200 it does not pass");
  });

  it("traded value below the minimum or without volume: illiquid", () => {
    // 162 × 3,000 ≈ 486,000 < 500,000
    assert.equal(
      filterZero(
        series((i) => 100 + i * 0.25, 3_000),
        TODAY,
        RULES,
      ),
      "illiquid",
    );
    assert.equal(
      filterZero(
        series((i) => 100 + i * 0.25, null),
        TODAY,
        RULES,
      ),
      "illiquid",
    );
  });
});

describe("medianTurnover", () => {
  it("median close × volume of the last sessions, ignoring those without volume", () => {
    const bars = weekdayBars("2026-09-14", [10, 20, 30, 40]).map((b, i) => (i === 0 ? b : { ...b, volume: 100 }));
    assert.equal(medianTurnover(bars, 3), 3000);
    assert.equal(medianTurnover(bars, 4), 3000, "the bar without volume does not count");
    assert.equal(medianTurnover(bars.slice(0, 1), 1), null);
  });
});

describe("factors", () => {
  it("closeness to the 52-week high: last close / high, capped at 1", () => {
    const bars = weekdayBars("2026-09-14", [100, 120, 90]);
    assert.equal(proximityTo52wHigh(bars), 0.75);
    assert.equal(proximityTo52wHigh(weekdayBars("2026-09-14", [100])), 1);
  });

  it("relative strength: the security's return minus the benchmark's on the same dates", () => {
    const stock = weekdayBars("2026-09-14", [100, 105, 110]);
    const reference = weekdayBars("2026-09-14", [50, 51, 52.5]);
    assert.ok(Math.abs(relativeStrength(stock, reference, 2)! - 0.05) < 1e-12); // +10% − +5%
  });

  it("the benchmark is aligned by date, not by position (different holidays)", () => {
    const stock = weekdayBars("2026-09-14", [100, 105, 110]); // 14, 15, 16
    const reference = [
      { date: "2026-09-11", close: 40, high: 40, low: 40 },
      { date: "2026-09-14", close: 50, high: 50, low: 50 },
      { date: "2026-09-16", close: 55, high: 55, low: 55 },
    ];
    assert.ok(Math.abs(relativeStrength(stock, reference, 2)! - 0) < 1e-12); // +10% − +10%
  });

  it("null if the security lacks the sessions or the benchmark does not cover the dates", () => {
    assert.equal(relativeStrength(weekdayBars("2026-09-14", [1, 2]), rising, 2), null);
    assert.equal(relativeStrength(weekdayBars("2026-09-14", [1, 2, 3]), weekdayBars("2026-09-15", [1, 2]), 2), null);
  });
});

describe("percentileRanks and scoreSilo", () => {
  it("percentiles in [0, 1] with ties averaged", () => {
    assert.deepEqual(percentileRanks([10, 30, 20]), [0, 1, 0.5]);
    assert.deepEqual(percentileRanks([5, 5, 9]), [0.25, 0.25, 1]);
    assert.deepEqual(percentileRanks([7]), [1]);
  });

  it("scores with the mean of the two percentiles and breaks ties by relative strength", () => {
    const entry = (ticker: string, proximity: number, rs: number) => ({
      item: { ticker, currency: "USD" as const },
      bars: [],
      proximity,
      relativeStrength: rs,
    });
    const ranked = scoreSilo([
      entry("NEAR", 1, 0),
      entry("STRONG", 0.8, 0.3),
      entry("BOTH", 0.95, 0.2),
      entry("WEAK", 0.7, -0.1),
    ]);
    assert.deepEqual(
      ranked.map((r) => [r.item.ticker, r.rank, r.score]),
      [
        ["STRONG", 1, 0.667],
        ["BOTH", 2, 0.667],
        ["NEAR", 3, 0.667],
        ["WEAK", 4, 0],
      ],
    );
  });
});

describe("selectFromRanking", () => {
  const ticker = (t: string, currency: "EUR" | "USD") => ({ ticker: t, currency });
  const ranked = (items: RankableTicker[]) =>
    items.map((item, i) => ({ item, rank: i + 1, score: 1 - i / 10, proximity: 1, relativeStrength: 0, bars: [] }));
  const ranking: UniverseRanking<RankableTicker> = {
    bySilo: {
      EUR: ranked(["E1", "E2", "E3", "E4", "E5"].map((t) => ticker(t, "EUR"))),
      USD: ranked(["U1", "U2"].map((t) => ticker(t, "USD"))),
    },
    excluded: [],
  };

  it("the N best non-excluded per silo, with their place in the whole silo, and exploration among the rest", () => {
    // random() = 0 → the shuffle puts the second of the rest first (E5 after E4, E5 → E5).
    const selected = selectFromRanking(
      ranking,
      (t) => t === "E1",
      RULES,
      () => 0,
    );
    assert.deepEqual(
      selected.map((c) => [c.item.ticker, c.rank, c.exploration ?? false]),
      [
        ["E2", 2, false],
        ["E3", 3, false],
        ["E5", 5, true],
        ["U1", 1, false],
        ["U2", 2, false],
      ],
    );
  });

  it("exploration never repeats a ranking candidate and is missing if no eligibles are left", () => {
    for (let k = 0; k < 20; k++) {
      const selected = selectFromRanking(ranking, () => false, RULES);
      const explored = selected.filter((c) => c.exploration).map((c) => c.item.ticker);
      assert.equal(explored.length, 1);
      assert.ok(["E3", "E4", "E5"].includes(explored[0]));
    }
    const usd = selectFromRanking(ranking, () => false, RULES).filter((c) => c.item.currency === "USD");
    assert.ok(
      usd.every((c) => !c.exploration),
      "USD only has 2 eligibles: both by ranking",
    );
  });
});

describe("historyLoader", () => {
  it("downloads each series once, also the failing ones, which count as no data", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const load = historyLoader(
      {
        getHistorical: async (t: string) => {
          calls.push(t);
          if (t === "FAIL") throw new Error("persistent 429");
          return rising;
        },
      },
      (msg) => logs.push(msg),
    );
    assert.equal(await load("OK"), rising);
    assert.equal(await load("OK"), rising);
    assert.deepEqual(await load("FAIL"), []);
    assert.deepEqual(await load("FAIL"), []);
    assert.deepEqual(calls, ["OK", "FAIL"]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /FAIL: no history \(persistent 429\)/);
  });
});

describe("rankUniverse", () => {
  const universe = [
    { ticker: "UP.PA", currency: "EUR" as const },
    { ticker: "DOWN.PA", currency: "EUR" as const },
    { ticker: "UP", currency: "USD" as const },
    { ticker: "STEEP", currency: "USD" as const },
  ];
  const data: Record<string, HistoricalBar[]> = {
    "EXSA.DE": rising,
    VOO: rising,
    "UP.PA": rising,
    "DOWN.PA": series((i) => 200 - i * 0.25),
    UP: rising,
    STEEP: series((i) => 100 + i * 0.5),
  };
  const loader = (overrides: Record<string, HistoricalBar[]> = {}) =>
    historyLoader(
      {
        getHistorical: async (t: string) => {
          const bars = { ...data, ...overrides }[t];
          if (!bars) throw new Error("404");
          return bars;
        },
      },
      () => {},
    );
  /** The same series shifted: it ends `days` calendar days earlier. */
  const shifted = (bars: HistoricalBar[], days: number) =>
    bars.map((b) => ({
      ...b,
      date: new Date(Date.parse(`${b.date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10),
    }));

  it("sorts each silo's eligibles and records why each excluded one is left out", async () => {
    const outcome = await rankUniverse(universe, loader(), TODAY, RULES);
    assert.ok(outcome.ok);
    assert.deepEqual(
      outcome.ranking.bySilo.EUR.map((r) => r.item.ticker),
      ["UP.PA"],
    );
    assert.deepEqual(
      outcome.ranking.bySilo.USD.map((r) => [r.item.ticker, r.rank]),
      [
        ["STEEP", 1],
        ["UP", 2],
      ],
    );
    assert.deepEqual(outcome.ranking.excluded, [{ ticker: "DOWN.PA", reason: "below_sma200" }]);
    assert.equal(outcome.ranking.bySilo.USD[0].bars, data.STEEP, "the bars are reused for the candidate");
  });

  it("a security with an old last session is left out as stale; the rest of the ranking goes on", async () => {
    const outcome = await rankUniverse(universe, loader({ UP: shifted(rising, 14) }), TODAY, RULES);
    assert.ok(outcome.ok);
    assert.deepEqual(
      outcome.ranking.bySilo.USD.map((r) => r.item.ticker),
      ["STEEP"],
    );
    assert.deepEqual(
      outcome.ranking.excluded.find((e) => e.ticker === "UP"),
      { ticker: "UP", reason: "stale" },
    );
  });

  it("without dates in common with the benchmark: no_overlap, not no_data", async () => {
    // EUR benchmark with plenty of up-to-date sessions, but all after the start of the security's 6 months.
    const start = Date.parse(`${rising[rising.length - 1 - RULES.relativeStrengthSessions].date}T00:00:00Z`);
    const lateReference: HistoricalBar[] = [];
    for (let d = start + 86_400_000; d <= Date.parse(`${rising.at(-1)!.date}T00:00:00Z`); d += 86_400_000) {
      lateReference.push({ date: new Date(d).toISOString().slice(0, 10), close: 100, high: 100, low: 100 });
    }
    const outcome = await rankUniverse(universe, loader({ "EXSA.DE": lateReference }), TODAY, RULES);
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.ranking.bySilo.EUR, []);
    assert.deepEqual(
      outcome.ranking.excluded.find((e) => e.ticker === "UP.PA"),
      { ticker: "UP.PA", reason: "no_overlap" },
    );
  });

  it("without recent history for a benchmark there is no ranking", async () => {
    assert.deepEqual(await rankUniverse(universe, loader({ VOO: [] }), TODAY, RULES), {
      ok: false,
      reason: { code: "no_reference_history", ticker: "VOO" },
    });
    assert.deepEqual(await rankUniverse(universe, loader({ "EXSA.DE": shifted(rising, 14) }), TODAY, RULES), {
      ok: false,
      reason: { code: "no_reference_history", ticker: "EXSA.DE" },
    });
  });

  it("with less than 80% of the universe with data there is no ranking (e.g. persistent 429)", async () => {
    const outcome = await rankUniverse(universe, loader({ UP: [], STEEP: [] }), TODAY, RULES);
    assert.deepEqual(outcome, { ok: false, reason: { code: "low_coverage", withData: 2, total: 4 } });
  });

  it("with the universe's median session outside this week there is no ranking, even if one security is up to date", async () => {
    const stale = shifted(rising, 14);
    const outcome = await rankUniverse(universe, loader({ "DOWN.PA": stale, UP: stale, STEEP: stale }), TODAY, RULES);
    assert.deepEqual(outcome, { ok: false, reason: { code: "stale_universe", medianLastBar: stale.at(-1)!.date } });
  });
});

describe("drawWithFilterZero", () => {
  const eur = (t: string): RankableTicker => ({ ticker: t, currency: "EUR" });
  const usd = (t: string): RankableTicker => ({ ticker: t, currency: "USD" });
  const falling = series((i) => 200 - i * 0.25);
  const bars: Record<string, HistoricalBar[]> = {
    E1: falling,
    E2: rising,
    E3: rising,
    U1: rising,
    U2: falling,
    U3: rising,
    U4: rising,
  };

  it("takes per block the first drawn non-excluded ones that pass filter 0 and looks at no more than needed", async () => {
    const looked: string[] = [];
    const load = async (t: string) => (looked.push(t), bars[t]);
    // random() = 0.99 keeps the original order.
    const selected = await drawWithFilterZero(
      {
        eur: [eur("E1"), eur("E2"), eur("E3")],
        usd: [usd("U1"), usd("U2"), usd("U3"), usd("U4")],
        commodities: [eur("C1")],
      },
      (t) => t === "U1",
      load,
      TODAY,
      RULES,
      () => 0.99,
    );
    assert.deepEqual(
      selected.map((c) => c.item.ticker),
      ["E2", "U3", "U4"],
    );
    assert.ok(selected.every((c) => c.bars === rising && c.rank == null && !c.exploration));
    assert.deepEqual(
      looked,
      ["E1", "E2", "U2", "U3", "U4"],
      "neither E3 (quota full), nor U1 (excluded), nor C1 (quota 0)",
    );
  });

  it("if not enough pass filter 0, returns those there are", async () => {
    const selected = await drawWithFilterZero(
      { eur: [eur("E1")], usd: [usd("U2"), usd("U3")], commodities: [] },
      () => false,
      async (t) => bars[t],
      TODAY,
      RULES,
    );
    assert.deepEqual(
      selected.map((c) => c.item.ticker),
      ["U3"],
    );
  });
});
