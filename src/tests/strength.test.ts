/**
 * Tests of utils/strength.ts (ADR-0006): best-effort capture of technical
 * strength at decision time. No network — the provider is injected.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachStrength } from "../utils/strength.js";
import type { HistoricalBar } from "../providers/types.js";
import type { Signal } from "../types.js";
import { parseTicker as tk } from "../ticker.js";

/** Rising series of `n` sessions: enough for SMA200 and an ALCISTA bias. */
function risingBars(n = 260): HistoricalBar[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * 0.5;
    return { date: `2026-01-${(i % 28) + 1}`, open: close, high: close + 1, low: close - 1, close, volume: 1000 };
  });
}

function flatBars(n = 260): HistoricalBar[] {
  return Array.from({ length: n }, () => ({
    date: "2026-01-01",
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1000,
  }));
}

const signal = (ticker = "XOM", price = 230): Signal => ({
  ticker: tk(ticker),
  currency: "USD",
  triggers: ["big_move"],
  price,
  cash: 1000,
  siloValue: 1000,
});

describe("attachStrength", () => {
  it("annotates rangePosition and bias on the signal", async () => {
    const signals = [signal()];
    await attachStrength(signals, { getHistorical: async () => risingBars() }, () => {});

    assert.ok(signals[0].strength, "it must annotate the strength");
    assert.equal(signals[0].strength.bias, "ALCISTA");
    assert.ok(signals[0].strength.rangePosition > 0.9, "price near the yearly high");
  });

  // The ATR is already computed in computeTechnicals and is the unit
  // in which the ticket stop is sized.
  it("also annotates ATR14, with no extra requests", async () => {
    const signals = [signal()];
    await attachStrength(signals, { getHistorical: async () => risingBars() }, () => {});

    // risingBars: high/low at ±1 from the close → ATR14 ≈ 2.
    assert.ok(signals[0].strength?.atr14 != null, "it must annotate the ATR");
    assert.ok(Math.abs(signals[0].strength.atr14 - 2) < 0.5);
  });

  it("with ATR 0 it does not annotate atr14, but does annotate the rest of the strength", async () => {
    // Real yearly range (200 rising sessions) and the last 20 pinned: ATR14
    // comes out 0 and is useless to size any stop.
    const bars = [...risingBars(200), ...flatBars(20).map((b) => ({ ...b, close: 199, high: 199, low: 199 }))];
    const signals = [signal("FLAT", 199)];
    await attachStrength(signals, { getHistorical: async () => bars }, () => {});

    assert.ok(signals[0].strength, "the rest of the strength is annotated");
    assert.equal(signals[0].strength?.atr14, undefined);
  });

  // The signal price is today's and the bars may lag a day: a new high would
  // give 1.04 and the log would store an impossible position.
  it("clamps the range position to [0,1] if the price leaves the yearly range", async () => {
    const above = [signal("HIGH", 300)];
    await attachStrength(above, { getHistorical: async () => risingBars() }, () => {});
    assert.equal(above[0].strength?.rangePosition, 1);

    const below = [signal("LOW", 50)];
    await attachStrength(below, { getHistorical: async () => risingBars() }, () => {});
    assert.equal(below[0].strength?.rangePosition, 0);
  });

  it("without getHistorical in the provider annotates nothing and does not throw", async () => {
    const signals = [signal()];
    await attachStrength(signals, {}, () => {});
    assert.equal(signals[0].strength, undefined);
  });

  it("if getHistorical throws, the signal goes on without strength (it does not break the run)", async () => {
    const signals = [signal()];
    const logged: string[] = [];
    await attachStrength(
      signals,
      {
        getHistorical: async () => {
          throw new Error("HTTP 403 Forbidden");
        },
      },
      (m) => logged.push(m),
    );

    assert.equal(signals[0].strength, undefined);
    assert.match(logged[0], /HTTP 403 Forbidden/);
  });

  it("without historical bars annotates nothing", async () => {
    const signals = [signal()];
    const logged: string[] = [];
    await attachStrength(signals, { getHistorical: async () => [] }, (m) => logged.push(m));

    assert.equal(signals[0].strength, undefined);
    assert.match(logged[0], /no history/);
  });

  // With 52w High == 52w Low the range position is 0/0 = NaN: writing it to the
  // Markdown log and the decision log would poison any later measurement.
  it("with a degenerate yearly range (high == low) does not annotate a NaN", async () => {
    const signals = [signal("FLAT", 100)];
    const logged: string[] = [];
    await attachStrength(signals, { getHistorical: async () => flatBars() }, (m) => logged.push(m));

    assert.equal(signals[0].strength, undefined);
    assert.match(logged[0], /degenerate yearly range/);
  });

  it("a failure in one ticker does not prevent annotating the others", async () => {
    const signals = [signal("BAD"), signal("GOOD")];
    await attachStrength(
      signals,
      {
        getHistorical: async (ticker) => {
          if (ticker === "BAD") throw new Error("boom");
          return risingBars();
        },
      },
      () => {},
    );

    assert.equal(signals[0].strength, undefined);
    assert.ok(signals[1].strength, "the second ticker is annotated");
  });
});
