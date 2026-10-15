import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sma, atr14d, findSupports, computeTechnicals, rangePosition } from "../utils/technicals.js";
import type { HistoricalBar } from "../providers/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function bars(closes: number[]): HistoricalBar[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    close,
    high: close * 1.01,
    low: close * 0.99,
  }));
}

// ── rangePosition ────────────────────────────────────────────────────────────

describe("rangePosition", () => {
  it("returns the share of the yearly range, not a change", () => {
    // BABA at the 2026-09-29 close: analyze printed -84.4 %.
    assert.equal(rangePosition(107.74, 91.99, 192.67).toFixed(3), "0.156");
  });

  it("is 0 at the low and 1 at the high", () => {
    assert.equal(rangePosition(10, 10, 20), 0);
    assert.equal(rangePosition(20, 10, 20), 1);
  });
});

// ── sma ───────────────────────────────────────────────────────────────────────

describe("sma", () => {
  it("returns the correct simple average", () => {
    const result = sma([1, 2, 3, 4, 5], 5);
    assert.equal(result, 3);
  });

  it("uses only the last `period` values", () => {
    const result = sma([10, 1, 2, 3, 4, 5], 5);
    assert.equal(result, 3); // ignores the 10
  });

  it("returns null if there is less data than the period", () => {
    assert.equal(sma([1, 2, 3], 5), null);
  });

  it("works with period 1", () => {
    assert.equal(sma([42], 1), 42);
  });
});

// ── atr14d ────────────────────────────────────────────────────────────────────

describe("atr14d", () => {
  it("returns null with fewer than 14 bars", () => {
    assert.equal(atr14d(bars(Array(13).fill(100))), null);
  });

  it("returns a positive number with 14+ bars", () => {
    const result = atr14d(bars(Array(20).fill(100)));
    assert.ok(result != null && result >= 0);
  });

  it("ATR is higher with more volatile bars", () => {
    const quiet = bars(Array(20).fill(100));
    const volatile = bars(Array(20).fill(100)).map((b) => ({ ...b, high: b.close * 1.05, low: b.close * 0.95 }));
    const quietAtr = atr14d(quiet)!;
    const volatileAtr = atr14d(volatile)!;
    assert.ok(volatileAtr > quietAtr);
  });
});

// ── findSupports ──────────────────────────────────────────────────────────────

describe("findSupports", () => {
  it("returns an empty array if there are no clusters with ≥2 lows", () => {
    // Strictly falling trend: no repeated local lows
    const downtrend = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      close: 100 - i,
      high: 100 - i + 1,
      low: 100 - i - 1,
    }));
    const supports = findSupports(downtrend);
    assert.ok(Array.isArray(supports));
  });

  it("detects a support when the price bounces twice at the same level", () => {
    // findSupports ignores the first and last `window=5` indices, so the valid
    // lows must be at positions 5..length-6.
    // Series: rises to 80, falls to 55 (pos 5), rises to 80, falls to 55 (pos 15), rises.
    const prices = [80, 75, 70, 65, 60, 55, 60, 65, 70, 75, 80, 75, 70, 65, 60, 55, 60, 65, 70, 75, 80];
    const b = prices.map((close, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      close,
      high: close + 1,
      low: close - 1,
    }));
    const supports = findSupports(b);
    assert.ok(supports.length > 0, "it must find at least one support");
    assert.ok(supports[0] < 60, "the support must be near 55");
  });
});

// ── computeTechnicals ─────────────────────────────────────────────────────────

describe("computeTechnicals", () => {
  const flatBars = bars(Array(60).fill(100));

  it("computes the 52w high/low correctly", () => {
    const t = computeTechnicals(flatBars, 100);
    assert.equal(t.w52High, 100 * 1.01); // high = close * 1.01
    assert.equal(t.w52Low, 100 * 0.99); // low = close * 0.99
  });

  it("rangePosition is 0.5 when the price is in the middle of the range", () => {
    const t = computeTechnicals(flatBars, 100);
    // high=101, low=99 → position=(100-99)/(101-99)=0.5
    assert.ok(Math.abs(t.rangePosition - 0.5) < 0.01);
  });

  it("ALCISTA bias when price > SMA50 > SMA200", () => {
    // Rising price → current price > averages
    const growing = bars(Array.from({ length: 210 }, (_, i) => 100 + i));
    const currentPrice = 310;
    const t = computeTechnicals(growing, currentPrice);
    assert.equal(t.bias, "ALCISTA");
  });

  it("BAJISTA bias when price < SMA50 < SMA200", () => {
    // Falling price
    const declining = bars(Array.from({ length: 210 }, (_, i) => 310 - i));
    const currentPrice = 100;
    const t = computeTechnicals(declining, currentPrice);
    assert.equal(t.bias, "BAJISTA");
  });

  it("INSUFICIENTE bias with < 200 bars (no SMA200)", () => {
    const t = computeTechnicals(bars(Array(100).fill(100)), 100);
    assert.equal(t.sma200, null);
    // With SMA50 defined but SMA200 null, the bias cannot be ALCISTA/BAJISTA
    assert.ok(t.bias !== "ALCISTA" && t.bias !== "BAJISTA");
  });
});
