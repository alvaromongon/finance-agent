import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateEntryEligibility, MOMENTUM_ATR_LIMIT } from "../utils/entry-eligibility.js";
import type { Technicals } from "../utils/technicals.js";

function makeTechnicals(over: Partial<Technicals>): Technicals {
  return {
    currentPrice: 100,
    w52High: 150,
    w52Low: 80,
    rangePosition: 0.5,
    sma50: 98,
    sma200: 95,
    atr14: 2,
    supports: [90],
    resistances: [],
    bias: "ALCISTA",
    ...over,
  };
}

describe("evaluateEntryEligibility", () => {
  it("returns eligible with a healthy trend", () => {
    const e = evaluateEntryEligibility(makeTechnicals({}));
    assert.equal(e.verdict, "eligible");
    assert.deepEqual(e.reasons, []);
  });

  it("blocks on a bearish trend", () => {
    const e = evaluateEntryEligibility(makeTechnicals({ bias: "BAJISTA" }));
    assert.equal(e.verdict, "blocked");
    assert.deepEqual(e.reasons, ["trend_bearish"]);
  });

  it("blocks on momentum when the price falls more than 1.5 ATR below the SMA50", () => {
    // price 100, SMA50 104, ATR 2 → -2 ATR
    const e = evaluateEntryEligibility(makeTechnicals({ sma50: 104, bias: "MIXTO" }));
    assert.equal(e.verdict, "blocked");
    assert.deepEqual(e.reasons, ["momentum_below_sma50"]);
    assert.equal(e.sma50DistanceAtr, -2);
  });

  it("does not block on momentum right at the limit", () => {
    // price 100, SMA50 103, ATR 2 → exactly -1.5, which is not < -1.5
    const e = evaluateEntryEligibility(makeTechnicals({ sma50: 103, bias: "MIXTO" }));
    assert.equal(e.sma50DistanceAtr, MOMENTUM_ATR_LIMIT);
    assert.equal(e.verdict, "eligible");
  });

  it("collects several block reasons", () => {
    const e = evaluateEntryEligibility(makeTechnicals({ bias: "BAJISTA", sma50: 106 }), "adverso");
    assert.deepEqual(e.reasons, ["trend_bearish", "momentum_below_sma50", "regime_adverse"]);
  });

  it("leaves sma50DistanceAtr null if SMA50 or ATR is missing", () => {
    assert.equal(evaluateEntryEligibility(makeTechnicals({ sma50: null })).sma50DistanceAtr, null);
    assert.equal(evaluateEntryEligibility(makeTechnicals({ atr14: 0 })).sma50DistanceAtr, null);
  });

  describe("historical cases from August 2026", () => {
    it("ADBE: blocks on momentum, which was the only reason (MIXTO bias)", () => {
      const e = evaluateEntryEligibility(
        makeTechnicals({ currentPrice: 490, sma50: 548.03, sma200: 402.77, atr14: 22.33, bias: "MIXTO" }),
      );
      assert.equal(e.verdict, "blocked");
      assert.deepEqual(e.reasons, ["momentum_below_sma50"]);
      assert.ok(e.sma50DistanceAtr != null && e.sma50DistanceAtr < -2.5);
    });

    it("SGO.PA: blocks on trend, not on momentum", () => {
      const e = evaluateEntryEligibility(
        makeTechnicals({ currentPrice: 79.2, sma50: 79.22, sma200: 80.06, atr14: 1.75, bias: "BAJISTA" }),
      );
      assert.deepEqual(e.reasons, ["trend_bearish"]);
      // Momentum alone would have let it through: it sits right at the SMA50.
      assert.ok(e.sma50DistanceAtr != null && e.sma50DistanceAtr > MOMENTUM_ATR_LIMIT);
    });
  });
});

describe("evaluateEntryEligibility — market regime", () => {
  it("in an adverse regime a healthy asset is blocked with regime_adverse", () => {
    const e = evaluateEntryEligibility(makeTechnicals({}), "adverso");
    assert.equal(e.verdict, "blocked");
    assert.deepEqual(e.reasons, ["regime_adverse"]);
  });

  it("neutral, favorable or no regime: no effect", () => {
    for (const regime of ["neutral", "favorable", undefined] as const) {
      assert.equal(evaluateEntryEligibility(makeTechnicals({}), regime).verdict, "eligible");
    }
  });
});
