/**
 * Tests of risk.ts: only arithmetic on the ticket the engine
 * computes. The calibratable rules (R:R, anchored target) are in sizing.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { validateTicket } from "../risk.js";
import type { AdjustStopTicket, BuyTicket, Position, SellTicket } from "../types.js";

const buy = (overrides: Partial<BuyTicket> = {}): BuyTicket => ({
  kind: "BUY",
  currency: "USD",
  entry: 100,
  stop: 91,
  stopAtr: 3,
  units: 2.6666,
  amount: 266.66,
  costs: 0,
  taxPct: 0,
  risk: 24,
  riskBudget: 24,
  cappedBy: "risk",
  target: 120,
  rrGross: 2.22,
  rrNet: 2.22,
  ...overrides,
});

const position = (overrides: Partial<Position> = {}): Position => ({
  ticker: "XOM",
  currency: "USD",
  volume: 10,
  avgPrice: 130,
  currentPrice: 138,
  pl: 80,
  stopLoss: 125,
  ...overrides,
});

const sell = (overrides: Partial<SellTicket> = {}): SellTicket => ({
  kind: "SELL",
  currency: "USD",
  price: 138,
  amount: 400,
  units: 2.8985,
  ...overrides,
});

const adjust: AdjustStopTicket = {
  kind: "ADJUST_STOP",
  currency: "USD",
  price: 138,
  stop: 132,
  previousStop: 125,
  stopAtr: 3,
};

const codes = (r: ReturnType<typeof validateTicket>) => r.errors.map((e) => e.code);

describe("validateTicket — BUY", () => {
  it("with enough cash it is valid", () => {
    const r = validateTicket(buy(), { cash: 1000 });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it("amount + costs above the cash: insufficient_cash", () => {
    assert.deepEqual(codes(validateTicket(buy({ amount: 100, costs: 0.4 }), { cash: 100 })), ["insufficient_cash"]);
  });

  it(`with fractional shares, below the minimum order (${config.broker.minOrderValue}): below_min_order`, () => {
    assert.deepEqual(codes(validateTicket(buy({ units: 0.09, amount: 9 }), { cash: 1000 })), ["below_min_order"]);
  });

  it("the minimum order is the configured broker's", () => {
    const rules = { fractionalShares: true, minOrderValue: 50 };
    const r = validateTicket(buy({ units: 0.4, amount: 40 }), { cash: 1000 }, rules);
    assert.deepEqual(codes(r), ["below_min_order"]);
    assert.match(r.errors[0].message, /the minimum order \(50 USD\)/);
    assert.equal(validateTicket(buy({ units: 0.5, amount: 50 }), { cash: 1000 }, rules).valid, true);
  });

  it("if cash capped the units, the reason is insufficient_cash", () => {
    assert.deepEqual(codes(validateTicket(buy({ units: 0.05, amount: 5, cappedBy: "cash" }), { cash: 5 })), [
      "insufficient_cash",
    ]);
  });

  it("with whole shares, zero units fall short; a cheap share does not", () => {
    const wholeShares = { fractionalShares: false, minOrderValue: 10 };
    assert.deepEqual(codes(validateTicket(buy({ units: 0, amount: 0 }), { cash: 1000 }, wholeShares)), [
      "below_min_order",
    ]);
    assert.equal(
      validateTicket(buy({ entry: 5, stop: 4, units: 1, amount: 5 }), { cash: 1000 }, wholeShares).valid,
      true,
    );
  });

  it("stop at or above the entry: stop_not_below_entry", () => {
    assert.deepEqual(codes(validateTicket(buy({ stop: 100 }), { cash: 1000 })), ["stop_not_below_entry"]);
  });

  it("collects all the errors", () => {
    const r = validateTicket(buy({ stop: 120, amount: 5, units: 0.05 }), { cash: 1 });
    assert.deepEqual(codes(r).sort(), ["below_min_order", "insufficient_cash", "stop_not_below_entry"]);
  });
});

describe("validateTicket — SELL", () => {
  it("with a position of enough value it is valid", () => {
    assert.equal(validateTicket(sell(), { cash: 0, position: position() }).valid, true);
  });

  it("without a recorded position: no_position, like an ADJUST_STOP", () => {
    assert.deepEqual(codes(validateTicket(sell(), { cash: 0 })), ["no_position"]);
  });

  it("the cap is the value at the portfolio.md price, not the ticket's", () => {
    // 1 × 138 = 138; even if the ticket says price 500, 300 cannot be sold.
    const r = validateTicket(sell({ price: 500, amount: 300 }), { cash: 0, position: position({ volume: 1 }) });
    assert.deepEqual(codes(r), ["sell_above_position"]);
  });

  it("amount 0: invalid_amount", () => {
    assert.deepEqual(codes(validateTicket(sell({ amount: 0 }), { cash: 0, position: position() })), ["invalid_amount"]);
  });
});

describe("validateTicket — ADJUST_STOP", () => {
  it("with a position it is valid and does not look at cash or amounts", () => {
    assert.equal(validateTicket(adjust, { cash: 0, position: position() }).valid, true);
  });

  it("without a position: no_position", () => {
    assert.deepEqual(codes(validateTicket(adjust, { cash: 1000 })), ["no_position"]);
  });
});
