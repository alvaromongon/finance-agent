// Tests of the crossed-stop warning: what counts as a cross. The email is in
// heartbeat-digest.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectStopBreaches } from "../utils/stop-breach.js";
import type { Position } from "../types.js";

function position(overrides: Partial<Position> = {}): Position {
  return {
    ticker: "CAT",
    currency: "USD",
    volume: 1,
    avgPrice: 218,
    currentPrice: 216.9,
    pl: -1.1,
    stopLoss: 213,
    ...overrides,
  };
}

describe("detectStopBreaches", () => {
  it("detects the price below the stop", () => {
    const breaches = detectStopBreaches([position()], new Map([["CAT", 210.77]]));

    assert.equal(breaches.length, 1);
    assert.equal(breaches[0].ticker, "CAT");
    assert.equal(breaches[0].price, 210.77);
    assert.equal(breaches[0].stopLoss, 213);
    assert.ok(Math.abs(breaches[0].belowStopPct - 1.047) < 0.01);
    assert.ok(Math.abs(breaches[0].unrealizedPl - -7.23) < 0.01);
  });

  it("does not warn if the price is above the stop, even by a little", () => {
    const breaches = detectStopBreaches([position()], new Map([["CAT", 213.01]]));
    assert.deepEqual(breaches, []);
  });

  it("a price exactly at the stop does not count as a cross", () => {
    const breaches = detectStopBreaches([position()], new Map([["CAT", 213]]));
    assert.deepEqual(breaches, []);
  });

  it("ignores positions without a stop-loss", () => {
    const breaches = detectStopBreaches([position({ stopLoss: null })], new Map([["CAT", 1]]));
    assert.deepEqual(breaches, []);
  });

  it("ignores positions without a market price", () => {
    const breaches = detectStopBreaches([position()], new Map());
    assert.deepEqual(breaches, []);
  });

  it("uses the market price, not the vault's stale currentPrice", () => {
    // Real case of 2026-08-31: portfolio.md said 79.858,60 (sync of 27-Aug)
    // and the market was at 67.308,25, below the 77.000 stop.
    const btc = position({
      ticker: "BTC-EUR",
      currency: "EUR",
      volume: 0.01,
      avgPrice: 80_577.6,
      currentPrice: 79_858.6,
      stopLoss: 77_000,
    });
    const breaches = detectStopBreaches([btc], new Map([["BTC-EUR", 67_308.25]]));

    assert.equal(breaches.length, 1, "the stop is crossed according to the market, not the vault");
    assert.ok(breaches[0].belowStopPct > 12);
  });

  it("returns every crossed position", () => {
    const breaches = detectStopBreaches(
      [position(), position({ ticker: "ADBE", avgPrice: 490, stopLoss: 460 })],
      new Map([
        ["CAT", 210.77],
        ["ADBE", 455],
      ]),
    );
    assert.deepEqual(
      breaches.map((b) => b.ticker),
      ["CAT", "ADBE"],
    );
  });
});
