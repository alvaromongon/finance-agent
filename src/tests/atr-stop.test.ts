/**
 * Tests of utils/atr-stop.ts: the stop is measured in multiples of
 * ATR, so the same percentage distance is "loose" for a calm security and
 * "tight" for a volatile one. No network — the history provider is injected.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_STOP_ATR,
  STOP_ATR_BY_HORIZON,
  atrMultiple,
  detectTightStops,
  fetchAtrForPositions,
  suggestStop,
} from "../utils/atr-stop.js";
import type { HistoricalBar } from "../providers/types.js";
import type { Position } from "../types.js";

function position(overrides: Partial<Position> = {}): Position {
  return {
    ticker: "MSFT",
    currency: "USD",
    volume: 1,
    avgPrice: 492.01,
    currentPrice: 501.02,
    pl: 9.01,
    stopLoss: 500,
    ...overrides,
  };
}

/** Flat series with daily range `range`: ATR14 converges exactly to `range`. */
function barsWithRange(range: number, close = 100, n = 30): HistoricalBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-08-${(i % 28) + 1}`,
    close,
    high: close + range / 2,
    low: close - range / 2,
  }));
}

describe("atrMultiple", () => {
  it("measures the stop distance in ATR", () => {
    assert.equal(atrMultiple(100, 94, 3), 2);
  });

  it("the same 3% is 1.5 ATR for a calm security and 0.6 for a volatile one", () => {
    // The case behind the issue: MSFT (ATR 1.93%) vs ADBE (ATR 4.84%).
    const calm = atrMultiple(100, 97, 1.93)!;
    const volatileOne = atrMultiple(100, 97, 4.84)!;

    assert.ok(Math.abs(calm - 1.55) < 0.01);
    assert.ok(Math.abs(volatileOne - 0.62) < 0.01);
    assert.ok(calm > volatileOne);
  });

  it("a stop above the price (protecting profit) gives a negative multiple", () => {
    assert.equal(atrMultiple(95, 100, 5), -1);
  });

  it("returns null if the ATR is not usable", () => {
    assert.equal(atrMultiple(100, 94, null), null);
    assert.equal(atrMultiple(100, 94, 0), null);
    assert.equal(atrMultiple(100, 94, NaN), null);
  });
});

describe("suggestStop", () => {
  it("places the stop at the horizon reference distance", () => {
    assert.equal(suggestStop(100, 4, "medium"), 100 - STOP_ATR_BY_HORIZON.medium * 4);
    assert.equal(suggestStop(100, 4, "short"), 100 - STOP_ATR_BY_HORIZON.short * 4);
  });

  it("the medium horizon tolerates more noise than short", () => {
    assert.ok(suggestStop(100, 4, "medium") < suggestStop(100, 4, "short"));
  });

  it("defaults to the medium horizon and rounds to 2 decimals", () => {
    assert.equal(suggestStop(492.01, 9.4567), suggestStop(492.01, 9.4567, "medium"));
    assert.equal(suggestStop(492.01, 9.4567), 463.64);
  });

  it("the suggested stop always stays above the minimum accepted", () => {
    const price = 100;
    const atr = 3;
    assert.ok(suggestStop(price, atr, "short") < price - MIN_STOP_ATR * atr);
  });
});

describe("detectTightStops", () => {
  const prices = new Map([["MSFT", 501.02]]);
  // MSFT ATR14 on 2026-09-01 ≈ 1.93% of 501 ≈ 9.67.
  const atrs = new Map([["MSFT", 9.67]]);

  it("detects the MSFT case of 2026-09-01: the stop was within the session noise", () => {
    const tight = detectTightStops([position()], prices, atrs);

    assert.equal(tight.length, 1);
    assert.equal(tight[0].ticker, "MSFT");
    assert.ok(Math.abs(tight[0].multiple - 0.105) < 0.01, `multiple = ${tight[0].multiple}`);
  });

  it("does not warn when the stop respects the minimum", () => {
    // Stop at 2.5 ATR: 501.02 − 2.5 × 9.67 ≈ 476.84.
    const tight = detectTightStops([position({ stopLoss: 476.84 })], prices, atrs);
    assert.deepEqual(tight, []);
  });

  it("the bound is strict: exactly the minimum does not warn", () => {
    // Round numbers on purpose: the multiple is exact in binary and the test
    // checks the bound, not the floating-point error.
    const atLimit = [position({ ticker: "X", stopLoss: 100 - MIN_STOP_ATR * 3 })];
    assert.deepEqual(detectTightStops(atLimit, new Map([["X", 100]]), new Map([["X", 3]])), []);

    const slightlyCloser = [position({ ticker: "X", stopLoss: 100 - MIN_STOP_ATR * 3 + 0.01 })];
    assert.equal(detectTightStops(slightlyCloser, new Map([["X", 100]]), new Map([["X", 3]])).length, 1);
  });

  it("respects a minimum other than the default", () => {
    const stopLoss = 501.02 - 2.5 * 9.67;
    assert.deepEqual(detectTightStops([position({ stopLoss })], prices, atrs), []);
    assert.equal(detectTightStops([position({ stopLoss })], prices, atrs, 3).length, 1);
  });

  it("ignores positions without a stop", () => {
    assert.deepEqual(detectTightStops([position({ stopLoss: null })], prices, atrs), []);
  });

  it("ignores positions whose price already crossed the stop (that is detectStopBreaches)", () => {
    const tight = detectTightStops([position()], new Map([["MSFT", 499]]), atrs);
    assert.deepEqual(tight, []);
  });

  it("ignores positions without a computable ATR — it does not make up a multiple", () => {
    assert.deepEqual(detectTightStops([position()], prices, new Map()), []);
  });

  it("flags whether the reference stop would fall below the average price", () => {
    // MSFT bought at 492.01: a stop at 3 ATR (≈472) ends up below the entry.
    const [tight] = detectTightStops([position()], prices, atrs);
    assert.equal(tight.suggestedBelowEntry, true);

    // The same position with a much earlier entry: the stop still protects profit.
    const [withMargin] = detectTightStops([position({ avgPrice: 400 })], prices, atrs);
    assert.equal(withMargin.suggestedBelowEntry, false);
  });

  it("exposes distance and ATR in % so they can be read together", () => {
    const [tight] = detectTightStops([position()], prices, atrs);
    assert.ok(Math.abs(tight.distancePct - 0.2) < 0.05);
    assert.ok(Math.abs(tight.atrPct - 1.93) < 0.05);
  });
});

describe("fetchAtrForPositions", () => {
  it("computes the ATR only for positions with a stop", async () => {
    const requested: string[] = [];
    const provider = {
      async getHistorical(ticker: string) {
        requested.push(ticker);
        return barsWithRange(4);
      },
    };

    const atrs = await fetchAtrForPositions(
      [position({ ticker: "AVGO" }), position({ ticker: "UNH", stopLoss: null })],
      provider,
    );

    assert.deepEqual(requested, ["AVGO"]);
    assert.ok(Math.abs(atrs.get("AVGO")! - 4) < 0.01);
    assert.equal(atrs.has("UNH"), false);
  });

  it("a provider failure leaves the ticker without ATR, it does not break the run", async () => {
    const warnings: string[] = [];
    const provider = {
      async getHistorical(ticker: string) {
        if (ticker === "AVGO") throw new Error("502 Bad Gateway");
        return barsWithRange(2);
      },
    };

    const atrs = await fetchAtrForPositions(
      [position({ ticker: "AVGO" }), position({ ticker: "UNH" })],
      provider,
      (msg) => warnings.push(msg),
    );

    assert.equal(atrs.has("AVGO"), false);
    assert.ok(atrs.has("UNH"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /AVGO/);
  });

  it("without enough history no ATR is recorded", async () => {
    const provider = {
      async getHistorical() {
        return barsWithRange(4, 100, 5);
      },
    };
    const atrs = await fetchAtrForPositions([position()], provider);
    assert.equal(atrs.size, 0);
  });

  it("a provider without getHistorical returns an empty map", async () => {
    assert.equal((await fetchAtrForPositions([position()], {})).size, 0);
  });
});
