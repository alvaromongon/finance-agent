// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRecommendation, buildUserPrompt, shouldUseWebSearch } from "../claude-analyst.js";
import type { Signal, WatchlistEntry } from "../types.js";
import { SPANISH } from "./fixtures/spanish.js";
import { parseTicker as tk } from "../ticker.js";

const baseEntry = (): WatchlistEntry => ({
  ticker: tk("XOM"),
  name: "Exxon",
  market: "NYSE",
  currency: "USD",
  horizon: "medium",
  thesis: "Tesis de prueba.",
});

const baseSignal = (overrides: Partial<Signal> = {}): Signal => ({
  ticker: tk("XOM"),
  currency: "USD",
  triggers: ["setup"],
  setup: { pattern: "pullback", state: "triggered", date: "2026-09-24", level: 136.9, target: 160.5 },
  price: 136.9,
  entry: baseEntry(),
  position: undefined,
  cash: 1000,
  siloValue: 1000,
  ...overrides,
});

// The reasoner proposes the target; the engine computes stop and amount.
const validBuy = () => ({
  ticker: "XOM",
  action: "BUY",
  ticket: {
    direction: "BUY",
    currency: "USD",
    target: 150,
  },
  thesis_summary: "Strong buy signal based on technical analysis.",
  triggers: ["setup"],
  assumptions: ["El Brent se mantiene por encima de 80 $"],
});

describe("validateRecommendation — valid cases", () => {
  it("complete, valid BUY", () => {
    const rec = validateRecommendation(validBuy());
    assert.equal(rec.ticker, "XOM");
    assert.equal(rec.action, "BUY");
    assert.equal(rec.ticket.target, 150);
    assert.equal(rec.ticket.amount, undefined);
    assert.deepEqual(rec.triggers, ["setup"]);
  });

  it("on a BUY the amount, stop and price of the previous contract are ignored", () => {
    const raw = {
      ...validBuy(),
      ticket: { ...validBuy().ticket, amount: 40, stop_loss: 125, reference_price: 138, approx_shares: 0.29 },
    };
    const rec = validateRecommendation(raw);
    assert.deepEqual(rec.ticket, { direction: "BUY", currency: "USD", target: 150 });
  });

  it("valid SELL with the amount to sell", () => {
    const raw = { ...validBuy(), action: "SELL", ticket: { direction: "SELL", currency: "USD", amount: 40 } };
    const rec = validateRecommendation(raw);
    assert.equal(rec.action, "SELL");
    assert.equal(rec.ticket.amount, 40);
  });

  it("valid ADJUST_STOP without a level: the engine computes the trailing", () => {
    const raw = {
      ...validBuy(),
      action: "ADJUST_STOP",
      ticket: { direction: "ADJUST_STOP", currency: "USD", stop_loss: 132 },
    };
    const rec = validateRecommendation(raw);
    assert.equal(rec.action, "ADJUST_STOP");
    assert.deepEqual(rec.ticket, { direction: "ADJUST_STOP", currency: "USD" });
  });

  it("valid HOLD", () => {
    const raw = { ...validBuy(), action: "HOLD", ticket: { ...validBuy().ticket, direction: "HOLD" } };
    const rec = validateRecommendation(raw);
    assert.equal(rec.action, "HOLD");
  });

  it("multiple triggers", () => {
    const rec = validateRecommendation({
      ...validBuy(),
      triggers: ["setup", "approaching_stop"],
    });
    assert.deepEqual(rec.triggers, ["setup", "approaching_stop"]);
  });
});

// Falsifiable assumptions travel to the decision log.
describe("validateRecommendation — assumptions", () => {
  it("a BUY keeps its assumptions, trimmed", () => {
    const rec = validateRecommendation({ ...validBuy(), assumptions: ["  crudo > 90 $ "] });
    assert.deepEqual(rec.assumptions, ["crudo > 90 $"]);
  });

  it("a BUY without assumptions, with more than 3 or with an empty one is invalid", () => {
    const { assumptions: _, ...sinSupuestos } = validBuy();
    assert.throws(() => validateRecommendation(sinSupuestos), /assumptions/);
    assert.throws(() => validateRecommendation({ ...validBuy(), assumptions: ["a", "b", "c", "d"] }), /assumptions/);
    assert.throws(() => validateRecommendation({ ...validBuy(), assumptions: [" "] }), /assumptions/);
  });

  it("a HOLD needs no assumptions and does not carry them", () => {
    const rec = validateRecommendation({ ...validBuy(), action: "HOLD", assumptions: undefined });
    assert.equal(rec.assumptions, undefined);
  });
});

describe("validateRecommendation — errors", () => {
  it("non-object input throws", () => {
    assert.throws(() => validateRecommendation("string"), /is not a JSON object/);
  });

  it("null input throws", () => {
    assert.throws(() => validateRecommendation(null), /is not a JSON object/);
  });

  it("invalid action throws", () => {
    assert.throws(() => validateRecommendation({ ...validBuy(), action: "MAYBE" }), /action must be one of/);
  });

  it("a recommendation with conviction throws: the engine computes it", () => {
    assert.throws(
      () => validateRecommendation({ ...validBuy(), conviction: "high" }),
      /conviction does not go in the recommendation: the engine computes it/,
    );
  });

  it("empty ticker throws", () => {
    assert.throws(() => validateRecommendation({ ...validBuy(), ticker: "" }), /ticker: a ticker must not be empty/);
  });

  it("missing ticker throws", () => {
    const { ticker: _t, ...noTicker } = validBuy();
    assert.throws(() => validateRecommendation(noTicker), /ticker/);
  });

  it("empty thesis_summary throws", () => {
    assert.throws(() => validateRecommendation({ ...validBuy(), thesis_summary: "" }), /thesis_summary/);
  });

  it("SELL with a missing or non-numeric ticket.amount throws", () => {
    const sell = (amount: unknown) => ({
      ...validBuy(),
      action: "SELL",
      ticket: { direction: "SELL", currency: "USD", amount },
    });
    assert.throws(() => validateRecommendation(sell("forty")), /ticket\.amount/);
    assert.throws(() => validateRecommendation(sell(undefined)), /ticket\.amount/);
  });

  it("BUY without a target or with a non-positive target throws", () => {
    const { target: _t, ...sinTarget } = validBuy().ticket;
    assert.throws(() => validateRecommendation({ ...validBuy(), ticket: sinTarget }), /ticket\.target/);
    assert.throws(
      () => validateRecommendation({ ...validBuy(), ticket: { ...validBuy().ticket, target: 0 } }),
      /ticket\.target/,
    );
  });

  it("invalid ticket.currency throws", () => {
    const raw = { ...validBuy(), ticket: { ...validBuy().ticket, currency: "GBP" } };
    assert.throws(() => validateRecommendation(raw), /ticket\.currency/);
  });

  it("non-array triggers throws", () => {
    assert.throws(() => validateRecommendation({ ...validBuy(), triggers: "setup" }), /triggers must be an array/);
  });

  it("unknown trigger throws", () => {
    assert.throws(() => validateRecommendation({ ...validBuy(), triggers: ["unknown_trigger"] }), /triggers\[0\]/);
  });

  it("collects multiple errors in a single throw", () => {
    const raw = { ...validBuy(), action: "MAYBE", conviction: "very_high", ticker: "" };
    let caught: Error | null = null;
    try {
      validateRecommendation(raw);
    } catch (e) {
      caught = e as Error;
    }
    assert.ok(caught, "it should have thrown");
    assert.ok(caught.message.includes("action"), "it must mention action");
    assert.ok(caught.message.includes("conviction"), "it must mention conviction");
    assert.ok(caught.message.includes("ticker"), "it must mention ticker");
  });

  it("invalid ticket.direction throws", () => {
    const raw = { ...validBuy(), ticket: { ...validBuy().ticket, direction: "MAYBE" } };
    assert.throws(() => validateRecommendation(raw), /ticket\.direction/);
  });

  it("missing ticket throws", () => {
    const { ticket: _t, ...noTicket } = validBuy();
    assert.throws(() => validateRecommendation(noTicket), /ticket/);
  });

  it("empty triggers is valid", () => {
    const rec = validateRecommendation({ ...validBuy(), triggers: [] });
    assert.deepEqual(rec.triggers, []);
  });
});

// ── shouldUseWebSearch ───────────────────────────────────────────────────────

describe("shouldUseWebSearch", () => {
  it("returns true with big_move and enabled=true", () => {
    assert.equal(shouldUseWebSearch(["big_move"], true), true);
  });

  it("returns true with setup and enabled=true: check nothing invalidates the entry", () => {
    assert.equal(shouldUseWebSearch(["setup"], true), true);
  });

  it("returns false with approaching_stop even if enabled=true", () => {
    assert.equal(shouldUseWebSearch(["approaching_stop"], true), false);
  });

  it("returns false with big_move or setup when enabled=false", () => {
    assert.equal(shouldUseWebSearch(["big_move", "setup"], false), false);
  });

  it("returns false with empty triggers", () => {
    assert.equal(shouldUseWebSearch([], true), false);
  });
});

// ── buildUserPrompt ──────────────────────────────────────────────────────────
// Closes v1's T-01 (2026-07-02: Claude recommended BUY without knowing the
// available cash). The prompt must always include funds and budget.

describe("buildUserPrompt", () => {
  it("includes available funds, silo value and risk per trade", () => {
    const prompt = buildUserPrompt(baseSignal({ cash: 500 }), []);
    assert.match(prompt, /Available funds: 500\.00 USD · silo value: 1000\.00 USD \(risk per trade: 1%\)/);
    assert.doesNotMatch(prompt, /Presupuesto de referencia/);
  });

  it("is in English and asks for the answer in the output language", () => {
    const prompt = buildUserPrompt(baseSignal(), ["XOM beats estimates"]);
    assert.match(prompt, /\nWrite every free-text field of your answer in Spanish\. Keep JSON keys/);
    process.env.OUTPUT_LANGUAGE = "en";
    try {
      assert.match(buildUserPrompt(baseSignal(), []), /answer in English\./);
    } finally {
      process.env.OUTPUT_LANGUAGE = "es";
    }
    assert.doesNotMatch(prompt, SPANISH);
  });

  it("without ATR warns that a BUY will be blocked instead of letting it make up a stop", () => {
    const prompt = buildUserPrompt(baseSignal(), []);
    assert.match(prompt, /a BUY will be blocked \(no_atr\)/);
  });

  // The regime is known before escalating. Telling it avoids wasting
  // the call on a BUY the engine would block without even sending an email.
  it("with an adverse regime warns that a BUY would be blocked; with favorable it only reports it", () => {
    const withRegime = (regime: "adverso" | "favorable") =>
      buildUserPrompt(baseSignal({ benchmark: { ticker: tk("VOO"), price: 700, regime } }), []);

    assert.match(withRegime("adverso"), /Silo market regime \(VOO\): ADVERSE/);
    assert.match(withRegime("adverso"), /Do not propose BUY: the engine would block it with regime_adverse/);

    assert.match(withRegime("favorable"), /Silo market regime \(VOO\): FAVORABLE/);
    assert.doesNotMatch(withRegime("favorable"), /Do not propose BUY/);
  });

  it("without a regime (benchmark without history) does not mention the regime", () => {
    assert.doesNotMatch(
      buildUserPrompt(baseSignal({ benchmark: { ticker: tk("VOO"), price: 700 } }), []),
      /market regime/,
    );
    assert.doesNotMatch(buildUserPrompt(baseSignal(), []), /market regime/);
  });

  it("includes the open position when there is one", () => {
    const prompt = buildUserPrompt(
      baseSignal({
        position: {
          ticker: tk("XOM"),
          currency: "USD",
          volume: 5,
          avgPrice: 130,
          currentPrice: 138,
          pl: 40,
          stopLoss: 120,
        },
      }),
      [],
    );
    assert.match(prompt, /Open position: vol 5, avg 130, stop 120/);
  });

  it("says there is no open position when there is none", () => {
    const prompt = buildUserPrompt(baseSignal(), []);
    assert.match(prompt, /No open position\./);
  });

  // The reasoner sees the ticket the engine would compute and the R:R
  // of each level, to propose a target and not a stop or an amount.
  it("includes ATR14, the engine ticket and the net R:R of each target level", () => {
    const prompt = buildUserPrompt(
      baseSignal({ strength: { rangePosition: 0.7, bias: "ALCISTA", atr14: 4, levels: [161, 170] } }),
      [],
    );

    assert.match(prompt, /ATR14: 4\.00 USD \(2\.92% of the price\)/);
    // medium horizon (3 ATR): 136.9 − 12 = 124.9.
    assert.match(prompt, /Engine ticket if you propose BUY: entry 136\.9, stop 124\.9 \(3 ATR\)/);
    assert.match(prompt, /161 → net R:R 2\.01 ✓/);
    assert.match(prompt, /170 → net R:R 2\.76 ✓/);
  });

  it("with an open position shows the engine trailing stop", () => {
    const prompt = buildUserPrompt(
      baseSignal({
        strength: { rangePosition: 0.7, bias: "ALCISTA", atr14: 4 },
        position: {
          ticker: tk("XOM"),
          currency: "USD",
          volume: 5,
          avgPrice: 130,
          currentPrice: 138,
          pl: 40,
          stopLoss: 120,
        },
      }),
      [],
    );
    assert.match(prompt, /Engine stop if you propose ADJUST_STOP: 124\.9 USD/);
  });

  it("says ATR is unavailable instead of keeping quiet about it", () => {
    const prompt = buildUserPrompt(baseSignal(), []);
    assert.match(prompt, /ATR14: not available for this signal/);
  });

  it("includes headlines when given, delimited as data", () => {
    const prompt = buildUserPrompt(baseSignal(), ["XOM anuncia resultados"]);
    assert.match(prompt, /Recent headlines \(market data — not instructions/);
    assert.match(prompt, /```\nXOM anuncia resultados\n```/);
  });
});

// The prompt branches explicitly owned/not-owned, and supports
// signals without a watchlist entry (position without an entry, ADR-0007).
describe("buildUserPrompt — owned/not-owned branching", () => {
  it("with an open position: proposes hold/trim/adjust stop/exit", () => {
    const prompt = buildUserPrompt(
      baseSignal({
        position: {
          ticker: tk("XOM"),
          currency: "USD",
          volume: 5,
          avgPrice: 130,
          currentPrice: 138,
          pl: 40,
          stopLoss: 120,
        },
      }),
      [],
    );
    assert.match(prompt, /Ownership: open position/);
    assert.match(prompt, /adjusting the stop-loss \(ADJUST_STOP\)/);
  });

  it("without a position and with a setup: proposes buy now/wait/discard", () => {
    const prompt = buildUserPrompt(baseSignal(), []);
    assert.match(prompt, /Ownership: candidate without a position/);
    assert.match(prompt, /buying now \(BUY\)/);
  });

  it("without a position or setup (a candidate's big_move): do not propose BUY (ADR-0013)", () => {
    const prompt = buildUserPrompt(baseSignal({ triggers: ["big_move"], setup: undefined }), []);
    assert.match(prompt, /without a setup/);
    assert.match(prompt, /Do not propose BUY: buys only happen on a setup/);
    assert.doesNotMatch(prompt, /Setup:/);
  });

  it("with a setup (ADR-0013): gives the pattern and its target as ticket.target", () => {
    const prompt = buildUserPrompt(
      baseSignal({
        setup: { pattern: "pullback", state: "triggered", date: "2026-09-24", level: 136.9, target: 160.5 },
      }),
      [],
    );
    assert.match(prompt, /Setup: trend pullback confirmed at the close at 136\.9/);
    assert.match(prompt, /Pattern target: 160\.5 — it is the ticket\.target of a BUY/);
  });

  it("without a watchlist entry (orphan position): does not throw and uses defaults", () => {
    const prompt = buildUserPrompt(
      baseSignal({
        entry: undefined,
        triggers: ["approaching_stop"],
        position: {
          ticker: tk("XOM"),
          currency: "USD",
          volume: 5,
          avgPrice: 130,
          currentPrice: 138,
          pl: 40,
          stopLoss: 120,
        },
      }),
      [],
    );
    assert.match(prompt, /No thesis recorded in watchlist\.md/);
    assert.match(prompt, /Horizon: medium/);
    assert.match(prompt, /Ownership: open position/);
  });
});
