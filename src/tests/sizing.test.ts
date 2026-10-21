/**
 * Tests of utils/sizing.ts: the engine sets stop and size by risk,
 * with a minimum R:R net of costs and a target anchored to a technical level. No network.
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import {
  TARGET_TOLERANCE_ATR,
  buildAdjustStopTicket,
  buildBuyTicket,
  describeAdjustStopPreview,
  describeBuyPreview,
  describeTicket,
  evaluateRecommendation,
  purchaseTaxPct,
  siloValue,
  sizeBuy,
  type SizingInput,
} from "../utils/sizing.js";
import { trailingStop } from "../utils/atr-stop.js";
import { findResistances, targetLevels } from "../utils/technicals.js";
import type { HistoricalBar } from "../providers/types.js";
import type { PortfolioSnapshot, Recommendation, Signal } from "../types.js";

// Entry 100, ATR 3, medium horizon: stop at 3 ATR = 91, 9 of risk per unit.
const input = (overrides: Partial<SizingInput> = {}): SizingInput => ({
  ticker: "XOM",
  currency: "USD",
  entry: 100,
  atr: 3,
  horizon: "medium",
  cash: 1000,
  siloValue: 2400,
  ...overrides,
});

describe("siloValue", () => {
  const portfolio: PortfolioSnapshot = {
    currency: "USD",
    cash: 500,
    lots: [],
    syncedAt: "2026-09-14",
    positions: [
      { ticker: "ADBE", currency: "USD", volume: 2, avgPrice: 480, currentPrice: 500, pl: 40, stopLoss: 450 },
    ],
  };

  it("adds cash and positions at market, with the run's prices if given", () => {
    assert.equal(siloValue(portfolio), 1500);
    assert.equal(siloValue(portfolio, new Map([["ADBE", 510]])), 1520);
  });

  it("counts cash held by pending orders: uses total cash if present", () => {
    assert.equal(siloValue({ ...portfolio, cash: 28, totalCash: 595 }), 1595);
  });
});

describe("purchaseTaxPct (ADR-0009 §7)", () => {
  it("charges by market suffix, only on stocks", () => {
    assert.equal(purchaseTaxPct("SGO.PA"), 0.4);
    assert.equal(purchaseTaxPct("REP.MC", "equity"), 0.2);
    assert.equal(purchaseTaxPct("DEF.MI"), 0.1);
    assert.equal(purchaseTaxPct("ADBE"), 0);
    assert.equal(purchaseTaxPct("EXSA.DE", "etf"), 0);
    assert.equal(purchaseTaxPct("SGLN.MI", "commodity"), 0);
  });
});

describe("sizeBuy", () => {
  it("stop at the horizon distance and units for 1% of risk", () => {
    const s = sizeBuy(input())!;
    assert.equal(s.stop, 91);
    assert.equal(s.stopAtr, 3);
    assert.equal(s.riskBudget, 24); // 1% of 2,400
    assert.equal(s.cappedBy, "risk");
    assert.equal(s.units, 2.6666); // 24 / 9, rounded down to 4 decimals
    assert.equal(s.amount, 266.66);
    assert.ok(s.risk <= s.riskBudget, "never risks more than the budget");
  });

  it("short horizon: 2.5 ATR", () => {
    assert.equal(sizeBuy(input({ horizon: "short" }))!.stop, 92.5);
  });

  it("a very low ATR is capped by the 25% per-position cap", () => {
    const s = sizeBuy(input({ atr: 0.2 }))!;
    assert.equal(s.cappedBy, "position");
    assert.equal(s.amount, 600);
  });

  it("without enough cash, cash caps it counting the tax", () => {
    const s = sizeBuy(input({ ticker: "SGO.PA", currency: "EUR", cash: 50 }))!;
    assert.equal(s.cappedBy, "cash");
    assert.equal(s.taxPct, 0.4);
    assert.ok(s.amount + s.costs <= 50);
  });

  it("with whole shares rounds down to units", () => {
    const s = sizeBuy(input(), { ...config.framework, fractionalShares: false, minOrderValue: 10 })!;
    assert.equal(s.units, 2);
    assert.equal(s.amount, 200);
  });

  it("without ATR there is no stop or size", () => {
    assert.equal(sizeBuy(input({ atr: null })), null);
    assert.equal(sizeBuy(input({ atr: 0 })), null);
  });
});

describe("buildBuyTicket — R:R and anchored target", () => {
  it("target within half an ATR of a level and R:R ≥ 2: no blocks", () => {
    const { ticket, reasons } = buildBuyTicket({ ...input(), target: 119, levels: [120] });
    assert.deepEqual(reasons, []);
    assert.equal(ticket!.rrGross, 2.11);
    assert.equal(ticket!.target, 119);
  });

  it("R:R below the minimum: rr_below_min, but the ticket is computed anyway", () => {
    const { ticket, reasons } = buildBuyTicket({ ...input(), target: 110, levels: [110] });
    assert.deepEqual(reasons, ["rr_below_min"]);
    assert.ok(ticket, "what is blocked is not hidden");
  });

  it("the R:R is required net of the buy tax", () => {
    // Gross (118.3 − 100) / 9 = 2.03; net (18.3 − 0.4) / 9 = 1.99.
    const { ticket, reasons } = buildBuyTicket({
      ...input({ ticker: "SGO.PA", currency: "EUR" }),
      target: 118.3,
      levels: [118.3],
    });
    assert.ok(ticket!.rrGross >= 2);
    assert.deepEqual(reasons, ["rr_below_min"]);
  });

  it(`a target far from every level (> ${TARGET_TOLERANCE_ATR} ATR) is not anchored`, () => {
    assert.deepEqual(buildBuyTicket({ ...input(), target: 125, levels: [150] }).reasons, ["target_not_anchored"]);
  });

  it("at highs there is no level above: target_not_anchored", () => {
    assert.deepEqual(buildBuyTicket({ ...input(), target: 125, levels: [] }).reasons, ["target_not_anchored"]);
  });

  it("without ATR: no_atr and no ticket", () => {
    assert.deepEqual(buildBuyTicket({ ...input({ atr: undefined }), target: 125, levels: [125] }), {
      ticket: null,
      reasons: ["no_atr"],
    });
  });
});

describe("trailingStop / buildAdjustStopTicket", () => {
  it("raises the stop to 3 ATR below the price", () => {
    assert.equal(trailingStop(150, 5, 120), 135);
    assert.equal(
      buildAdjustStopTicket({ price: 150, atr: 5, currentStop: 120, horizon: "medium", currency: "USD" }).ticket!.stop,
      135,
    );
  });

  it("never lowers it: stop_not_raised", () => {
    assert.equal(trailingStop(150, 5, 140), null);
    assert.deepEqual(
      buildAdjustStopTicket({ price: 150, atr: 5, currentStop: 140, horizon: "medium", currency: "USD" }),
      { ticket: null, reasons: ["stop_not_raised"] },
    );
  });

  it("without ATR: no_atr", () => {
    assert.deepEqual(
      buildAdjustStopTicket({ price: 150, atr: null, currentStop: 120, horizon: "medium", currency: "USD" }).reasons,
      ["no_atr"],
    );
  });
});

describe("evaluateRecommendation", () => {
  const signal = (overrides: Partial<Signal> = {}): Signal => ({
    ticker: "XOM",
    currency: "USD",
    triggers: ["big_move"],
    price: 100,
    cash: 1000,
    siloValue: 2400,
    strength: { rangePosition: 0.6, bias: "ALCISTA", atr14: 3, levels: [120] },
    setup: { pattern: "pullback", state: "triggered", date: "2026-09-24", level: 100, target: 120 },
    ...overrides,
  });
  const rec = (overrides: Partial<Recommendation> = {}): Recommendation => ({
    ticker: "XOM",
    action: "BUY",
    ticket: { direction: "BUY", currency: "USD", target: 120 },
    thesis_summary: "t",
    triggers: ["big_move"],
    assumptions: ["x"],
    ...overrides,
  });

  it("a BUY without a setup comes out with a ticket but blocked by no_setup: a single way in (ADR-0013)", () => {
    const ev = evaluateRecommendation(rec(), signal({ setup: undefined }));
    assert.equal(ev.blocked, true);
    assert.deepEqual(ev.reasons, ["no_setup"]);
    assert.equal(ev.ticket?.kind, "BUY");
  });

  it("a BUY in an adverse regime comes out with a ticket but blocked by regime_adverse", () => {
    const ev = evaluateRecommendation(rec(), signal({ benchmark: { ticker: "VOO", price: 600, regime: "adverso" } }));
    assert.equal(ev.blocked, true);
    assert.deepEqual(ev.reasons, ["regime_adverse"]);
    assert.equal(ev.ticket?.kind, "BUY");
    // Exits and stops do not change.
    const position = {
      ticker: "XOM",
      currency: "USD" as const,
      volume: 1,
      avgPrice: 90,
      currentPrice: 100,
      pl: 10,
      stopLoss: 85,
    };
    const sell = evaluateRecommendation(
      rec({ action: "SELL", ticket: { direction: "SELL", currency: "USD", amount: 100 } }),
      signal({ benchmark: { ticker: "VOO", price: 600, regime: "adverso" }, position }),
    );
    assert.equal(sell.blocked, false);
  });

  it("a BUY that meets the framework comes out with a ticket and no block; the price is the signal's", () => {
    const ev = evaluateRecommendation(rec(), signal());
    assert.equal(ev.blocked, false);
    assert.equal(ev.ticket?.kind, "BUY");
    assert.equal(ev.ticket?.kind === "BUY" && ev.ticket.entry, 100);
  });

  it("a BUY without a technical snapshot is blocked by no_atr", () => {
    const ev = evaluateRecommendation(rec(), signal({ strength: undefined }));
    assert.equal(ev.blocked, true);
    assert.deepEqual(ev.reasons, ["no_atr"]);
  });

  it("a BUY without cash is blocked by the arithmetic", () => {
    const ev = evaluateRecommendation(rec(), signal({ cash: 3 }));
    assert.equal(ev.blocked, true);
    assert.deepEqual(
      ev.errors.map((e) => e.code),
      ["insufficient_cash"],
    );
  });

  it("SELL above the position or without one and ADJUST_STOP without a position are blocked", () => {
    const position = {
      ticker: "XOM",
      currency: "USD" as const,
      volume: 1,
      avgPrice: 90,
      currentPrice: 100,
      pl: 10,
      stopLoss: 80,
    };
    const sellEv = evaluateRecommendation(
      rec({ action: "SELL", ticket: { direction: "SELL", currency: "USD", amount: 500 } }),
      signal({ position }),
    );
    assert.deepEqual(
      sellEv.errors.map((e) => e.code),
      ["sell_above_position"],
    );

    const orphanSellEv = evaluateRecommendation(
      rec({ action: "SELL", ticket: { direction: "SELL", currency: "USD", amount: 50 } }),
      signal(),
    );
    assert.equal(orphanSellEv.blocked, true);
    assert.deepEqual(
      orphanSellEv.errors.map((e) => e.code),
      ["no_position"],
    );

    const adjustEv = evaluateRecommendation(
      rec({ action: "ADJUST_STOP", ticket: { direction: "ADJUST_STOP", currency: "USD" } }),
      signal(),
    );
    assert.equal(adjustEv.blocked, true);
    assert.deepEqual(
      adjustEv.errors.map((e) => e.code),
      ["no_position"],
    );
  });

  it("HOLD has no ticket or block", () => {
    assert.deepEqual(evaluateRecommendation(rec({ action: "HOLD" }), signal()), {
      ticket: null,
      reasons: [],
      errors: [],
      blocked: false,
    });
  });
});

describe("ticket presentation", () => {
  it("describeTicket gives the reference price, the stop, the amount and the ticket R:R", () => {
    const { ticket } = buildBuyTicket({ ...input(), target: 119, levels: [120] });
    const rows = Object.fromEntries(describeTicket(ticket!));
    assert.equal(rows["Precio de referencia"], "100 USD");
    assert.equal(rows["Stop-loss"], "91 USD (3 ATR)");
    assert.equal(rows.Importe, "266.66 USD");
    assert.match(rows["R:R"], /2\.11 bruto · 2\.11 neto/);
  });

  it("describeBuyPreview marks the levels that reach the minimum R:R", () => {
    const text = describeBuyPreview({ ...input(), levels: [110, 120] }).join("\n");
    assert.match(text, /stop 91 \(3 ATR\)/);
    assert.match(text, /110 → net R:R 1\.11 ·/);
    assert.match(text, /120 → net R:R 2\.22 ✓/);
  });

  it("describeBuyPreview warns about what will be blocked", () => {
    assert.match(describeBuyPreview({ ...input(), levels: [] }).join("\n"), /target_not_anchored/);
    assert.match(describeBuyPreview({ ...input({ atr: null }), levels: [120] }).join("\n"), /no_atr/);
  });

  it("describeAdjustStopPreview says whether the stop rises or not", () => {
    assert.match(
      describeAdjustStopPreview({ price: 150, atr: 5, currentStop: 120, horizon: "medium", currency: "USD" }),
      /135 USD/,
    );
    assert.match(
      describeAdjustStopPreview({ price: 150, atr: 5, currentStop: 140, horizon: "medium", currency: "USD" }),
      /stop_not_raised/,
    );
  });
});

describe("findResistances / targetLevels", () => {
  /** Two peaks at 120 separated by a valley, current price 105. */
  function twoPeaks(): HistoricalBar[] {
    const closes = [100, 105, 110, 115, 120, 115, 110, 105, 100, 105, 110, 115, 120, 115, 110, 105, 100, 102, 104, 105];
    return closes.map((close, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      close,
      high: close + 1,
      low: close - 1,
    }));
  }

  it("a high touched twice is a resistance", () => {
    assert.deepEqual(findResistances(twoPeaks(), 3), [121]);
  });

  it("targetLevels only gives levels above the price, sorted and without repeats", () => {
    assert.deepEqual(targetLevels({ currentPrice: 105, resistances: [98, 121], w52High: 130 }), [121, 130]);
    assert.deepEqual(targetLevels({ currentPrice: 131, resistances: [121], w52High: 130 }), []);
  });
});
