import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectWatchedTickers, evaluateSignals, riskTriggers } from "../heartbeat.js";
import type { PortfolioSnapshot, Position, WatchlistEntry } from "../types.js";

const baseEntry = (): WatchlistEntry => ({
  ticker: "TEST",
  name: "Test Asset",
  market: "TEST",
  currency: "EUR",
  horizon: "medium",
  thesis: "test",
});

const emptyPortfolio = (): PortfolioSnapshot => ({
  currency: "EUR",
  cash: 1000,
  positions: [],
  lots: [],
  syncedAt: "2026-01-01T00:00:00Z",
});

const withPosition = (stopLoss: number | null): PortfolioSnapshot => ({
  ...emptyPortfolio(),
  positions: [
    {
      ticker: "TEST",
      currency: "EUR",
      volume: 10,
      avgPrice: 45,
      currentPrice: 45,
      pl: 0,
      stopLoss,
    } satisfies Position,
  ],
});

describe("evaluateSignals — approaching_stop", () => {
  it("a price within the stop margin fires approaching_stop", () => {
    // stopLoss=42, pct=3 → margin = 42 * 1.03 = 43.26 → price 43 ≤ 43.26 → fires
    const signals = evaluateSignals([baseEntry()], withPosition(42), new Map([["TEST", 43]]), 3);
    assert.ok(signals[0].triggers.includes("approaching_stop"));
  });

  it("a price exactly at the margin fires (inclusive bound)", () => {
    // margin = 42 * 1.03 = 43.26 → price 43.26 ≤ 43.26 → fires
    const signals = evaluateSignals([baseEntry()], withPosition(42), new Map([["TEST", 43.26]]), 3);
    assert.ok(signals[0].triggers.includes("approaching_stop"));
  });

  it("a price 1 cent above the margin does not fire", () => {
    // margin = 42 * 1.03 = 43.26 → price 43.27 > 43.26 → does not fire
    const signals = evaluateSignals([baseEntry()], withPosition(42), new Map([["TEST", 43.27]]), 3);
    assert.ok(!signals[0]?.triggers.includes("approaching_stop"));
  });

  it("a price above the margin does not fire", () => {
    const triggers = riskTriggers({
      price: 44,
      position: { ticker: "TEST", currency: "EUR", volume: 10, avgPrice: 45, currentPrice: 45, pl: 0, stopLoss: 42 },
      stopProximityPct: 3,
      bigMovePct: 5,
    });
    assert.ok(!triggers.includes("approaching_stop"));
  });

  it("without an open position approaching_stop does not fire", () => {
    const triggers = riskTriggers({
      price: 40,
      stopProximityPct: 3,
      bigMovePct: 5,
    });
    assert.ok(!triggers.includes("approaching_stop"));
  });

  it("a null stopLoss does not fire", () => {
    const triggers = riskTriggers({
      price: 40,
      position: { ticker: "TEST", currency: "EUR", volume: 10, avgPrice: 45, currentPrice: 45, pl: 0, stopLoss: null },
      stopProximityPct: 3,
      bigMovePct: 5,
    });
    assert.ok(!triggers.includes("approaching_stop"));
  });
});

// T-08: checks approaching_stop with realistic parameters
describe("evaluateSignals — T-08 approaching_stop DEF.MI", () => {
  const defEntry = (): WatchlistEntry => ({
    ticker: "DEF.MI",
    name: "Example Defence",
    market: "Euronext Milan",
    currency: "EUR",
    horizon: "medium",
    thesis: "European defence spending cycle",
  });

  const defPosition = (stopLoss: number): PortfolioSnapshot => ({
    currency: "EUR",
    cash: 5,
    positions: [
      {
        ticker: "DEF.MI",
        currency: "EUR",
        volume: 1,
        avgPrice: 46.8,
        currentPrice: 46.0,
        pl: -0.8,
        stopLoss,
      } satisfies Position,
    ],
    lots: [],
    syncedAt: "2026-06-27T17:00:00Z",
  });

  it("normal condition (stop 41.50 — pct 3%): does NOT fire at €46", () => {
    // margin = 41.50 × 1.03 = 42.725 → price 46 > 42.725 → no signal
    const signals = evaluateSignals([defEntry()], defPosition(41.5), new Map([["DEF.MI", 46.0]]));
    const approachingStopSignals = signals.filter((s) => s.triggers.includes("approaching_stop"));
    assert.equal(approachingStopSignals.length, 0);
  });

  it("Option A (stop raised to €45 — pct 3%): DOES fire at €46", () => {
    // margin = 45.00 × 1.03 = 46.35 → price 46 ≤ 46.35 → fires
    const signals = evaluateSignals([defEntry()], defPosition(45.0), new Map([["DEF.MI", 46.0]]));
    assert.equal(signals.length, 1);
    assert.ok(signals[0].triggers.includes("approaching_stop"));
  });

  it("Option B (real stop 41.50 — pct 15%): DOES fire at €46", () => {
    // margin = 41.50 × 1.15 = 47.725 → price 46 ≤ 47.725 → fires
    // Calls riskTriggers() directly with stopProximityPct=15
    // to check the computation independently of the env.
    const triggers = riskTriggers({
      price: 46.0,
      position: {
        ticker: "DEF.MI",
        currency: "EUR",
        volume: 1,
        avgPrice: 46.8,
        currentPrice: 46.0,
        pl: -0.8,
        stopLoss: 41.5,
      },
      stopProximityPct: 15,
      bigMovePct: 5,
    });
    assert.ok(triggers.includes("approaching_stop"));
  });
});

describe("evaluateSignals — big_move", () => {
  it("Δ=6% (>= default 5%) fires big_move", () => {
    // previousClose=100, price=106 → +6% → fires
    const entry = baseEntry();
    const signals = evaluateSignals([entry], emptyPortfolio(), new Map([["TEST", 106]]), 3, new Map([["TEST", 100]]));
    assert.equal(signals.length, 1);
    assert.ok(signals[0].triggers.includes("big_move"));
  });

  it("Δ=4% (< default 5%) does not fire", () => {
    const entry = baseEntry();
    const signals = evaluateSignals([entry], emptyPortfolio(), new Map([["TEST", 104]]), 3, new Map([["TEST", 100]]));
    assert.equal(signals.length, 0);
  });

  it("a Δ=6% drop also fires (absolute change)", () => {
    const entry = baseEntry();
    const signals = evaluateSignals([entry], emptyPortfolio(), new Map([["TEST", 94]]), 3, new Map([["TEST", 100]]));
    assert.ok(signals[0].triggers.includes("big_move"));
  });

  it("without previousClose big_move does not fire", () => {
    const entry = baseEntry();
    const signals = evaluateSignals([entry], emptyPortfolio(), new Map([["TEST", 106]]));
    assert.equal(signals.length, 0);
  });

  it("custom bigMovePct (10% threshold): Δ=6% does not fire", () => {
    const entry = baseEntry();
    const signals = evaluateSignals(
      [entry],
      emptyPortfolio(),
      new Map([["TEST", 106]]),
      3,
      new Map([["TEST", 100]]),
      10,
    );
    assert.equal(signals.length, 0);
  });
});

describe("evaluateSignals — general", () => {
  it("a candidate without a position or a big move generates no signal: setups decide its entry", () => {
    const signals = evaluateSignals(
      [baseEntry()],
      emptyPortfolio(),
      new Map([["TEST", 10]]),
      3,
      new Map([["TEST", 10.1]]),
    );
    assert.equal(signals.length, 0);
  });

  it("several triggers at once", () => {
    // stop 38 with pct 3% → margin 39.14 ≥ 35 → approaching_stop; 35 vs 40 → -12.5% → big_move
    const signals = evaluateSignals(
      [baseEntry()],
      withPosition(38),
      new Map([["TEST", 35]]),
      3,
      new Map([["TEST", 40]]),
    );
    assert.equal(signals.length, 1);
    assert.deepEqual(signals[0].triggers, ["approaching_stop", "big_move"]);
  });

  it("a ticker without a price in the map is skipped", () => {
    const signals = evaluateSignals([baseEntry()], emptyPortfolio(), new Map());
    assert.equal(signals.length, 0);
  });
});

// ADR-0007: Portfolio.md is the single source of truth for which
// positions to watch for risk — the heartbeat iterates over the union of
// portfolio.positions and watchlist, not just the watchlist.
describe("evaluateSignals — portfolio ∪ watchlist union", () => {
  it("a position without a watchlist entry DOES generate a Signal (approaching_stop) using the real stop-loss", () => {
    // No entry: empty watchlist, only a position in portfolio.md.
    const portfolio: PortfolioSnapshot = withPosition(42);
    const signals = evaluateSignals([], portfolio, new Map([["TEST", 43]]), 3);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].ticker, "TEST");
    assert.ok(signals[0].triggers.includes("approaching_stop"));
    assert.equal(signals[0].entry, undefined);
    assert.equal(signals[0].currency, "EUR"); // falls back to Position.currency
  });

  it("a ticker in both (watchlist + portfolio) is evaluated once, with its real entry", () => {
    const entry = baseEntry();
    const signals = evaluateSignals([entry], withPosition(42), new Map([["TEST", 43]]), 3);
    assert.equal(signals.length, 1);
    assert.deepEqual(signals[0].triggers, ["approaching_stop"]);
    assert.deepEqual(signals[0].entry, entry);
  });

  it("several positions without a watchlist entry: each is evaluated independently", () => {
    const portfolio: PortfolioSnapshot = {
      currency: "EUR",
      cash: 100,
      positions: [
        { ticker: "A", currency: "EUR", volume: 1, avgPrice: 10, currentPrice: 10, pl: 0, stopLoss: 9 },
        { ticker: "B", currency: "EUR", volume: 1, avgPrice: 20, currentPrice: 20, pl: 0, stopLoss: 19 },
      ],
      lots: [],
      syncedAt: "2026-01-01T00:00:00Z",
    };
    const prices = new Map([
      ["A", 9.1],
      ["B", 25],
    ]); // A near the stop; B far, no signal
    const signals = evaluateSignals([], portfolio, prices, 3);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].ticker, "A");
  });
});

describe("collectWatchedTickers", () => {
  it("watchlist ∪ portfolio.positions, deduplicated by ticker, watchlist first", () => {
    const portfolio: PortfolioSnapshot = {
      ...emptyPortfolio(),
      positions: [
        { ticker: "TEST", currency: "EUR", volume: 1, avgPrice: 1, currentPrice: 1, pl: 0, stopLoss: null },
        { ticker: "ONLY_PORTFOLIO", currency: "EUR", volume: 1, avgPrice: 1, currentPrice: 1, pl: 0, stopLoss: null },
      ],
    };
    const watchlist = [baseEntry(), { ...baseEntry(), ticker: "ONLY_WATCHLIST" }];
    assert.deepEqual(collectWatchedTickers(watchlist, portfolio), ["TEST", "ONLY_WATCHLIST", "ONLY_PORTFOLIO"]);
  });

  it("without a watchlist or positions returns an empty array", () => {
    assert.deepEqual(collectWatchedTickers([], emptyPortfolio()), []);
  });
});
