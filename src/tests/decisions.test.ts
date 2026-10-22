/**
 * Tests of decisions.ts: schema, validation and pure rules of the
 * single decision log. No network or vault.
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDecision,
  decisionFromRecommendation,
  entryRuleViolations,
  findOpenEntry,
  findRelatedProposal,
  originOf,
  resolveFxConversion,
  validateDecision,
  twoMonthRuleWarning,
  validateOwnerInput,
  type Decision,
} from "../decisions.js";
import type { BuyTicket, EngineTicket, Recommendation, Signal, WatchlistEntry } from "../types.js";

const base = (overrides: Partial<Decision> = {}): Omit<Decision, "id"> => ({
  date: "2026-09-14",
  ticker: "ADBE",
  currency: "USD",
  origin: "sistema",
  source: "monday-briefing",
  type: "hold",
  rules_version: "0.2",
  ...overrides,
});

const entry = (overrides: Partial<WatchlistEntry> = {}): WatchlistEntry => ({
  ticker: "ADBE",
  name: "Applied Materials",
  market: "NASDAQ",
  currency: "USD",
  horizon: "medium",
  thesis: "t",
  ...overrides,
});

describe("validateDecision", () => {
  it("accepts a minimal hold and gives it an id", () => {
    const d = buildDecision(base());
    assert.match(d.id, /^20260914-adbe-hold-[0-9a-f]{8}$/);
    assert.equal(validateDecision(d), d);
  });

  it("drops undefined fields instead of writing them", () => {
    const d = buildDecision(base({ price: undefined, conviction: "low" }));
    assert.ok(!("price" in d));
    assert.equal(d.conviction, "low");
  });

  it("conviction_points: engine rubric codes, only together with a conviction", () => {
    const d = buildDecision(base({ conviction: "medium", conviction_points: ["regime_favorable", "reward_risk"] }));
    assert.deepEqual(d.conviction_points, ["regime_favorable", "reward_risk"]);
    assert.doesNotThrow(() => buildDecision(base({ conviction: "low", conviction_points: [] })));
    assert.throws(
      () => buildDecision(base({ conviction: "low", conviction_points: ["intuición" as never] })),
      /conviction_points/,
    );
    assert.throws(() => buildDecision(base({ conviction_points: [] })), /conviction_points only goes with conviction/);
  });

  it("money flows carry no ticker", () => {
    assert.doesNotThrow(() =>
      buildDecision(
        base({ type: "deposit", ticker: null, origin: "propietario", source: "portfolio-sync", amount: 50 }),
      ),
    );
    assert.throws(() => buildDecision(base({ type: "deposit", amount: 50 })), /ticker must be null in deposit/);
  });

  it("buy_proposal requires a price and 1-3 assumptions", () => {
    assert.throws(
      () => buildDecision(base({ type: "buy_proposal" })),
      (err: Error) => err.message.includes("price is required") && err.message.includes("assumptions is required"),
    );
    assert.throws(
      () => buildDecision(base({ type: "buy_proposal", price: 500, assumptions: ["a", "b", "c", "d"] })),
      /1-3 non-empty strings/,
    );
    assert.doesNotThrow(() => buildDecision(base({ type: "buy_proposal", price: 500, assumptions: ["crudo > 90 $"] })));
  });

  it("setup (ADR-0013): valid pattern, state and level; setup_armed requires an armed setup, target and verdict", () => {
    const setup = { pattern: "breakout" as const, state: "armed" as const, level: 510 };
    assert.doesNotThrow(() =>
      buildDecision(
        base({
          type: "setup_armed",
          price: 500,
          target: 560,
          setup,
          eligibility: { verdict: "eligible", reasons: [] },
        }),
      ),
    );
    assert.throws(() => buildDecision(base({ setup: { ...setup, pattern: "cup" as "breakout" } })), /setup must be/);
    assert.throws(() => buildDecision(base({ setup: { ...setup, level: 0 } })), /setup must be/);
    assert.throws(
      () =>
        buildDecision(
          base({
            type: "setup_armed",
            price: 500,
            target: 560,
            setup: { ...setup, state: "triggered" },
            eligibility: { verdict: "eligible", reasons: [] },
          }),
        ),
      /state armed/,
    );
    assert.throws(
      () =>
        buildDecision(
          base({ type: "setup_armed", price: 500, setup, eligibility: { verdict: "eligible", reasons: [] } }),
        ),
      /target is required/,
    );
    assert.throws(
      () => buildDecision(base({ type: "setup_armed", price: 500, target: 560, setup })),
      /requires eligibility/,
    );
  });

  it("buy_blocked requires a blocked verdict with reasons", () => {
    assert.throws(() => buildDecision(base({ type: "buy_blocked" })), /verdict blocked/);
    assert.throws(
      () => buildDecision(base({ type: "buy_blocked", eligibility: { verdict: "blocked", reasons: [] } })),
      /without reasons/,
    );
    assert.doesNotThrow(() =>
      buildDecision(base({ type: "buy_blocked", eligibility: { verdict: "blocked", reasons: ["trend_bearish"] } })),
    );
  });

  it("rejects assumptions outside a buy proposal", () => {
    assert.throws(() => buildDecision(base({ assumptions: ["x"] })), /only goes in buy proposals/);
  });

  it("fx_conversion requires amount, rate and costs", () => {
    assert.throws(
      () => buildDecision(base({ type: "fx_conversion", ticker: null, currency: "EUR", amount: 100 })),
      (err: Error) => err.message.includes("fx_rate is required") && err.message.includes("costs is required"),
    );
  });

  it("regime: only favorable, neutral or adverso", () => {
    assert.equal(buildDecision(base({ regime: "neutral" })).regime, "neutral");
    assert.throws(
      () => validateDecision({ ...base(), id: "x", regime: "bajista" }),
      /regime must be one of \[favorable, neutral, adverso\]/,
    );
  });

  it("rank, score and exploration: only in the screening and with valid values (ADR-0012)", () => {
    const screen = base({ type: "screen_rejected", source: "screening", price: 100 });
    const ok = buildDecision({ ...screen, rank: 3, score: 0.5, exploration: true });
    assert.deepEqual([ok.rank, ok.score, ok.exploration], [3, 0.5, true]);
    assert.throws(
      () => validateDecision({ ...screen, id: "x", rank: 0, score: 1.2, exploration: "sí" }),
      (err: Error) =>
        err.message.includes("rank must be an integer >= 1") &&
        err.message.includes("score must be a number in [0, 1]") &&
        err.message.includes("exploration must be a boolean"),
    );
    assert.throws(() => buildDecision(base({ rank: 1 })), /only go in screening decisions/);
  });

  it("rejects unknown fields, malformed dates and non-positive numbers, all at once", () => {
    assert.throws(
      () => validateDecision({ ...base({ price: -1 }), id: "x", date: "14/09/2026", extra: true }),
      (err: Error) =>
        err.message.includes("unknown field: extra") &&
        err.message.includes("date must be YYYY-MM-DD") &&
        err.message.includes("price must be a number > 0"),
    );
  });
});

describe("decisionFromRecommendation", () => {
  const signal = (overrides: Partial<Signal> = {}): Signal => ({
    ticker: "ADBE",
    currency: "USD",
    triggers: ["big_move"],
    price: 500,
    entry: entry(),
    cash: 1000,
    siloValue: 2400,
    strength: { rangePosition: 0.4567, bias: "MIXTO", atr14: 12.34567 },
    benchmark: { ticker: "VOO", price: 700 },
    ...overrides,
  });
  const rec = (overrides: Partial<Recommendation> = {}): Recommendation => ({
    ticker: "ADBE",
    action: "BUY",
    ticket: { direction: "BUY", currency: "USD", target: 560 },
    thesis_summary: "t",
    triggers: ["big_move"],
    assumptions: ["El capex de IA se mantiene"],
    ...overrides,
  });
  const buyTicket: BuyTicket = {
    kind: "BUY",
    currency: "USD",
    entry: 500,
    stop: 463,
    stopAtr: 3,
    units: 0.6486,
    amount: 324.3,
    costs: 0,
    taxPct: 0,
    risk: 24,
    riskBudget: 24,
    cappedBy: "risk",
    target: 560,
    rrGross: 1.62,
    rrNet: 1.62,
  };
  const ctx = {
    date: "2026-09-14",
    rulesVersion: "0.2",
    source: "heartbeat" as const,
    logLink: "logs/2026-09-14-adbe.md",
    reasons: [] as string[],
    ticket: null as EngineTicket | null,
  };

  it("valid BUY: buy_proposal with the engine ticket, the technical snapshot, the benchmark and the assumptions", () => {
    const d = decisionFromRecommendation(rec(), signal(), { ...ctx, blocked: false, ticket: buyTicket })!;
    assert.equal(d.type, "buy_proposal");
    assert.equal(d.stop_initial, 463);
    assert.equal(d.target, 560);
    assert.equal(d.amount, 324.3);
    assert.deepEqual(d.strength, { range_position: 0.457, bias: "MIXTO" });
    assert.equal(d.atr14, 12.3457);
    assert.deepEqual(d.benchmark, { ticker: "VOO", price: 700 });
    assert.equal(d.horizon, "medium");
  });

  it("the benchmark regime goes to its own field, not inside benchmark", () => {
    const withRegime = signal();
    withRegime.benchmark = { ticker: "VOO", price: 700, regime: "adverso" };
    const d = decisionFromRecommendation(rec(), withRegime, {
      ...ctx,
      blocked: true,
      reasons: ["regime_adverse"],
      ticket: buyTicket,
    })!;
    assert.deepEqual(d.benchmark, { ticker: "VOO", price: 700 });
    assert.equal(d.regime, "adverso");
    assert.deepEqual(d.eligibility, { verdict: "blocked", reasons: ["regime_adverse"] });
  });

  it("blocked BUY: buy_blocked with its reasons, not hidden", () => {
    const d = decisionFromRecommendation(rec(), signal(), {
      ...ctx,
      blocked: true,
      reasons: ["rr_below_min"],
      ticket: buyTicket,
    })!;
    assert.equal(d.type, "buy_blocked");
    assert.deepEqual(d.eligibility, { verdict: "blocked", reasons: ["rr_below_min"] });
    assert.equal(d.stop_initial, 463);
  });

  it("HOLD is recorded; a SELL or ADJUST_STOP not carried out keeps the position, and without a position it is not a decision", () => {
    const position = {
      ticker: "ADBE",
      currency: "USD" as const,
      volume: 1,
      avgPrice: 480,
      currentPrice: 500,
      pl: 20,
      stopLoss: 450,
    };
    const sell = rec({
      action: "SELL",
      assumptions: undefined,
      ticket: { direction: "SELL", currency: "USD", amount: 900 },
    });
    const adjust = rec({
      action: "ADJUST_STOP",
      assumptions: undefined,
      ticket: { direction: "ADJUST_STOP", currency: "USD" },
    });

    assert.equal(
      decisionFromRecommendation(rec({ action: "HOLD", assumptions: undefined }), signal(), { ...ctx, blocked: false })!
        .type,
      "hold",
    );

    // As in the Monday Briefing: what is not carried out is a hold.
    const heldSell = decisionFromRecommendation(sell, signal({ position }), {
      ...ctx,
      blocked: true,
      reasons: ["sell_above_position"],
    })!;
    assert.equal(heldSell.type, "hold");
    assert.ok(!("conviction" in heldSell), "the conviction was the sale's");
    assert.equal(
      decisionFromRecommendation(adjust, signal({ position }), { ...ctx, blocked: true, reasons: ["stop_not_raised"] })!
        .type,
      "hold",
    );

    assert.equal(decisionFromRecommendation(sell, signal(), { ...ctx, blocked: true, reasons: ["no_position"] }), null);
  });

  it("the conviction is the engine's from the setup signal, with its points", () => {
    const setupSignal = signal({ conviction: { conviction: "medium", points: ["regime_favorable", "reward_risk"] } });
    const d = decisionFromRecommendation(rec(), setupSignal, { ...ctx, blocked: false, ticket: buyTicket })!;
    assert.equal(d.conviction, "medium");
    assert.deepEqual(d.conviction_points, ["regime_favorable", "reward_risk"]);
    const hold = decisionFromRecommendation(rec({ action: "HOLD", assumptions: undefined }), setupSignal, {
      ...ctx,
      blocked: false,
    })!;
    assert.equal(hold.conviction, "medium");
  });

  it("a risk signal carries no conviction", () => {
    const d = decisionFromRecommendation(rec({ action: "HOLD", assumptions: undefined }), signal(), {
      ...ctx,
      blocked: false,
    })!;
    assert.ok(!("conviction" in d));
    assert.ok(!("conviction_points" in d));
  });

  it("an unknown horizon in watchlist.md does not break the log", () => {
    const d = decisionFromRecommendation(
      rec({ action: "HOLD" }),
      signal({ entry: entry({ horizon: "long" as never }) }),
      { ...ctx, blocked: false },
    )!;
    assert.ok(!("horizon" in d));
  });
});

describe("twoMonthRuleWarning (art. 33.5.f LIRPF)", () => {
  const exit = (overrides: Partial<Decision> = {}) =>
    buildDecision(
      base({
        type: "exit",
        source: "portfolio-sync",
        origin: "propietario",
        date: "2026-08-31",
        price: 460,
        amount: 460,
        pnl: -30,
        ...overrides,
      }),
    );

  it("with a real account warns when buying back within two months of a loss-making sale (ADBE case)", () => {
    const w = twoMonthRuleWarning([exit()], "ADBE", "2026-09-09", "real");
    assert.match(w!, /ADBE se vendió con pérdida \(-30 USD\) el 2026-08-31/);
    assert.match(w!, /antes del 2026-10-31/);
  });

  it("does not warn in demo, out of the window, with a gain or without pnl", () => {
    assert.equal(twoMonthRuleWarning([exit()], "ADBE", "2026-09-09", "demo"), null);
    assert.equal(twoMonthRuleWarning([exit()], "ADBE", "2026-10-31", "real"), null);
    assert.equal(twoMonthRuleWarning([exit({ pnl: 12 })], "ADBE", "2026-09-09", "real"), null);
    assert.equal(twoMonthRuleWarning([exit({ pnl: undefined })], "ADBE", "2026-09-09", "real"), null);
  });

  it("pnl is only accepted in exit", () => {
    assert.throws(() => buildDecision(base({ pnl: -5 })), /pnl only goes in exit/);
  });
});

describe("validateDecision: the lot snapshot of an exit (ADR-0015)", () => {
  const exitLine = (overrides: Partial<Decision> = {}) =>
    base({ type: "exit", price: 120, amount: 480, source: "portfolio-sync", ...overrides });
  const snapshot: Partial<Decision> = {
    related_id: "entry-1",
    entry_price: 100,
    stop_initial: 90,
    entry_units: 10,
    entry_costs: 4,
    entry_date: "2026-06-15",
    entry_origin: "sistema",
    entry_rules_version: "1.0",
    rule_violations: ["no_stop"],
  };

  it("accepts an exit with its full snapshot and keeps every field", () => {
    const d = buildDecision(exitLine(snapshot));
    assert.equal(d.entry_price, 100);
    assert.equal(d.entry_units, 10);
    assert.equal(d.entry_costs, 4);
    assert.equal(d.entry_date, "2026-06-15");
    assert.equal(d.entry_origin, "sistema");
    assert.equal(d.entry_rules_version, "1.0");
    assert.deepEqual(d.rule_violations, ["no_stop"]);
  });

  it("an exit without a snapshot still parses (ADR-0006: optional fields, no log migration)", () => {
    const d = buildDecision(exitLine());
    assert.ok(!("entry_price" in d));
  });

  it("the entry costs and the stop are optional in the snapshot", () => {
    const { entry_costs: _costs, stop_initial: _stop, ...minimal } = snapshot;
    assert.doesNotThrow(() => buildDecision(exitLine(minimal)));
  });

  it("a partial snapshot names what is missing", () => {
    assert.throws(
      () => buildDecision(exitLine({ entry_price: 100 })),
      /entry_units is required with the lot snapshot[\s\S]*entry_date is required[\s\S]*entry_origin is required[\s\S]*entry_rules_version is required/,
    );
  });

  it("the snapshot needs the entry id: it is what identifies the lot", () => {
    const { related_id: _id, ...noId } = snapshot;
    assert.throws(() => buildDecision(exitLine(noId)), /related_id is required with the lot snapshot/);
  });

  it("an exit that only cites an entry (no snapshot) still parses", () => {
    assert.doesNotThrow(() => buildDecision(exitLine({ related_id: "entry-1" })));
  });

  it("snapshot fields only go in exit", () => {
    assert.throws(
      () => buildDecision(base({ type: "entry", price: 100, amount: 100, ...snapshot })),
      /only goes in exit/,
    );
  });

  it("rejects values that cannot be a lot", () => {
    assert.throws(() => buildDecision(exitLine({ ...snapshot, entry_units: 0 })), /entry_units must be a number > 0/);
    assert.throws(() => buildDecision(exitLine({ ...snapshot, entry_price: -1 })), /entry_price must be a number > 0/);
    assert.throws(() => buildDecision(exitLine({ ...snapshot, entry_costs: -1 })), /entry_costs must be a number >= 0/);
    assert.throws(
      () => buildDecision(exitLine({ ...snapshot, entry_date: "15/06/2026" })),
      /entry_date must be YYYY-MM-DD/,
    );
    assert.throws(
      () => buildDecision(exitLine({ ...snapshot, entry_origin: "broker" as never })),
      /entry_origin must be one of/,
    );
  });
});

describe("validateDecision: lot_units_left of an exit (#52)", () => {
  const exitLine = (overrides: Partial<Decision> = {}) =>
    base({
      type: "exit",
      price: 120,
      amount: 480,
      source: "portfolio-sync",
      related_id: "entry-1",
      entry_price: 100,
      stop_initial: 90,
      entry_units: 10,
      entry_date: "2026-06-15",
      entry_origin: "sistema",
      entry_rules_version: "1.0",
      ...overrides,
    });

  it("keeps the units the lot has left after the exit, 0 when the exit used it up", () => {
    assert.equal(buildDecision(exitLine({ lot_units_left: 6 })).lot_units_left, 6);
    assert.equal(buildDecision(exitLine({ lot_units_left: 0 })).lot_units_left, 0);
  });

  it("is optional: an exit with the snapshot but without it still parses", () => {
    assert.ok(!("lot_units_left" in buildDecision(exitLine())));
  });

  it("is a finite number >= 0", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "6" as never]) {
      assert.throws(
        () => buildDecision(exitLine({ lot_units_left: bad })),
        /lot_units_left must be a number >= 0/,
        String(bad),
      );
    }
  });

  it("only goes with the lot snapshot, and only in an exit", () => {
    assert.throws(
      () => buildDecision(base({ type: "exit", price: 120, amount: 480, lot_units_left: 3 })),
      /lot_units_left only goes with the lot snapshot/,
    );
    assert.throws(
      () => buildDecision(base({ type: "entry", price: 100, amount: 100, lot_units_left: 3 })),
      /lot_units_left only goes with the lot snapshot/,
    );
  });
});

describe("validateOwnerInput", () => {
  it("accepts an entry with units instead of an amount", () => {
    assert.doesNotThrow(() =>
      validateOwnerInput({ type: "entry", ticker: "CAT", currency: "USD", price: 30, units: 2, stop: 27 }),
    );
  });

  it("collects what is missing by type", () => {
    assert.throws(
      () => validateOwnerInput({ type: "entry", currency: "USD" }),
      (err: Error) =>
        err.message.includes("ticker is required") &&
        err.message.includes("price is required") &&
        err.message.includes("amount or units"),
    );
    assert.throws(
      () => validateOwnerInput({ type: "fx_conversion", currency: "EUR", amount: 100 }),
      /fx_rate or received/,
    );
    assert.throws(
      () => validateOwnerInput({ type: "deposit", currency: "EUR", amount: 50, ticker: "X" }),
      /ticker does not apply/,
    );
    assert.throws(() => validateOwnerInput({ type: "buy_proposal", currency: "EUR" }), /type must be one of/);
  });
});

describe("resolveFxConversion", () => {
  it("with the received amount, infers the rate on the amount net of the fee", () => {
    // €100 − €0.50 fee = €99.50 → $115.42: rate 1.16.
    assert.deepEqual(resolveFxConversion({ amount: 100, received: 115.42 }, 0.5), { costs: 0.5, fx_rate: 1.16 });
  });

  it("respects the fee and the rate the owner gives", () => {
    assert.deepEqual(resolveFxConversion({ amount: 100, fx_rate: 1.17, costs: 0.8 }, 0.5), {
      costs: 0.8,
      fx_rate: 1.17,
    });
  });
});

describe("entryRuleViolations", () => {
  it("outside the watchlist and without a stop", () => {
    assert.deepEqual(entryRuleViolations({ price: 30, minStopAtr: 2 }), ["not_in_watchlist", "no_stop"]);
  });

  it("without a system setup behind it and with the stop less than 2 ATR away (ADBE case, 09-Sep)", () => {
    assert.deepEqual(entryRuleViolations({ price: 580, stop: 560, entry: entry(), atr: 20, minStopAtr: 2 }), [
      "entry_without_setup",
      "stop_below_min_atr",
    ]);
    // A proposal without a setup (older ones) does not count either.
    const legacy = buildDecision(base({ type: "buy_proposal", price: 500, assumptions: ["a"] }));
    assert.deepEqual(entryRuleViolations({ price: 500, stop: 440, entry: entry(), proposal: legacy, minStopAtr: 2 }), [
      "entry_without_setup",
    ]);
  });

  it("after a setup and within the rules it breaks nothing; without ATR the stop is not evaluated", () => {
    const proposal = buildDecision(
      base({
        type: "buy_proposal",
        source: "heartbeat",
        price: 500,
        assumptions: ["a"],
        setup: { pattern: "pullback", state: "triggered", level: 500 },
      }),
    );
    assert.deepEqual(
      entryRuleViolations({ price: 500, stop: 440, entry: entry(), proposal, atr: 20, minStopAtr: 2 }),
      [],
    );
    assert.deepEqual(
      entryRuleViolations({ price: 500, stop: 499, entry: entry(), proposal, atr: null, minStopAtr: 2 }),
      [],
    );
  });
});

describe("findRelatedProposal / findOpenEntry", () => {
  const proposal = buildDecision(base({ type: "buy_proposal", date: "2026-09-08", price: 500, assumptions: ["a"] }));

  it("attributes the entry to the same ticker's proposal within the window", () => {
    assert.equal(
      findRelatedProposal([proposal], { ticker: "ADBE", date: "2026-09-14", types: ["buy_proposal"] })?.id,
      proposal.id,
    );
    assert.equal(
      findRelatedProposal([proposal], { ticker: "ADBE", date: "2026-09-30", types: ["buy_proposal"] }),
      undefined,
    );
    assert.equal(
      findRelatedProposal([proposal], { ticker: "HAL", date: "2026-09-14", types: ["buy_proposal"] }),
      undefined,
    );
  });

  it("a proposal already used by another entry is not reused", () => {
    const used = buildDecision(
      base({
        type: "entry",
        origin: "sistema",
        source: "portfolio-sync",
        price: 500,
        amount: 500,
        related_id: proposal.id,
      }),
    );
    assert.equal(
      findRelatedProposal([proposal, used], { ticker: "ADBE", date: "2026-09-14", types: ["buy_proposal"] }),
      undefined,
    );
  });

  it("an entry after an engine block cites it, but is the owner's", () => {
    const blocked = buildDecision(
      base({
        type: "buy_blocked",
        date: "2026-09-08",
        price: 500,
        eligibility: { verdict: "blocked", reasons: ["rr_below_min"] },
      }),
    );
    const related = findRelatedProposal([blocked], {
      ticker: "ADBE",
      date: "2026-09-14",
      types: ["buy_proposal", "buy_blocked"],
    });
    assert.equal(related?.id, blocked.id);
    assert.equal(originOf(related), "propietario");
    assert.equal(originOf(proposal), "sistema");
    assert.equal(originOf(undefined), "propietario");
  });

  it("the exit closes the ticker's last open entry", () => {
    const e1 = buildDecision(base({ type: "entry", source: "portfolio-sync", price: 490, amount: 490 }));
    const x1 = buildDecision(
      base({ type: "exit", source: "portfolio-sync", price: 460, amount: 460, related_id: e1.id }),
    );
    const e2 = buildDecision(base({ type: "entry", source: "portfolio-sync", price: 535, amount: 535 }));
    assert.equal(findOpenEntry([e1, x1, e2], "ADBE")?.id, e2.id);
    assert.equal(findOpenEntry([e1, x1], "ADBE"), undefined);
  });
});

describe("validateDecision: units of an exit (B1 of PR #56)", () => {
  const exitLine = (overrides: Partial<Decision> = {}) =>
    base({ type: "exit", price: 120, amount: 480, source: "portfolio-sync", ...overrides });

  it("an exit may carry the units it sold", () => {
    assert.equal(buildDecision(exitLine({ units: 4 })).units, 4);
  });

  it("units is a number > 0 in an exit too", () => {
    for (const bad of [0, -1, Number.NaN]) {
      assert.throws(() => buildDecision(exitLine({ units: bad })), /units must be a number > 0/, String(bad));
    }
  });

  it("units only goes in an entry or an exit", () => {
    assert.throws(
      () => buildDecision(base({ type: "adjust_stop", stop: 90, units: 4 })),
      /units only goes in entry or exit/,
    );
  });
});
