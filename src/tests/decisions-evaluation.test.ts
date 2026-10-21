/**
 * Tests of the decision evaluation: plan in R, stop or target
 * first, forward return and excess, net R of closed trades, aggregates,
 * cutoff table and its render. Fixtures, no network or vault.
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDecision, type Decision } from "../decisions.js";
import {
  buildCutBoard,
  buildEvaluationReport,
  buyPlan,
  closedTrades,
  counterStart,
  decisionGroupings,
  evaluateDecisions,
  evaluationSymbols,
  excursion,
  groupStats,
  isCv1,
  measureTrades,
  type BuyPlan,
  type EvaluationFramework,
  type EvaluationInput,
} from "../utils/decisions-evaluation.js";
import {
  CUT_BOARD_HEADING,
  boardWarnings,
  extractCutBoard,
  renderDecisionsEvaluation,
} from "../utils/decisions-evaluation-render.js";
import type { HistoricalBar } from "../providers/types.js";
import type { Currency, PortfolioSnapshot } from "../types.js";
import { closes, weekdayBars } from "./fixtures/weekday-bars.js";
import { en } from "../i18n/en.js";
import { es } from "../i18n/es.js";
import { SPANISH } from "./fixtures/spanish.js";

function assertClose(actual: number | null | undefined, expected: number, epsilon = 1e-9) {
  assert.ok(actual != null && Math.abs(actual - expected) < epsilon, `esperado ${expected}, obtenido ${actual}`);
}

const FRAMEWORK: EvaluationFramework = {
  reference: { EUR: "EXSA.DE", USD: "VOO" },
  minRewardRisk: 2,
  cutReviewTrades: 30,
  cutDecisionTrades: 50,
  drawdownPausePct: 15,
};

const decision = (fields: Partial<Decision> & Pick<Decision, "type">): Decision =>
  buildDecision({
    date: "2026-09-01",
    ticker: "AAA",
    currency: "USD",
    origin: "sistema",
    source: "monday-briefing",
    price: 100,
    rules_version: "0.4",
    ...fields,
  });

/** Weekday sessions from `start` with [close, high, low]. */
function ohlc(start: string, rows: [number, number, number][]): HistoricalBar[] {
  return weekdayBars(
    start,
    rows.map((r) => r[0]),
  ).map((b, i) => ({ ...b, high: rows[i][1], low: rows[i][2] }));
}

const snapshot = (currency: Currency, cash: number): PortfolioSnapshot => ({
  currency,
  cash,
  positions: [],
  lots: [],
  syncedAt: "2026-09-25",
});

describe("isCv1", () => {
  it("C v1 is rules 1.0 and later", () => {
    assert.equal(isCv1("0.4"), false);
    assert.equal(isCv1("1.0"), true);
    assert.equal(isCv1("1.3"), true);
    assert.equal(isCv1("10.1"), true);
  });
});

describe("buyPlan", () => {
  const proposal = decision({
    type: "buy_proposal",
    assumptions: ["El capex se mantiene"],
    stop_initial: 91,
    target: 119,
  });

  it("uses the stop and target of the engine ticket", () => {
    assert.deepEqual(buyPlan(proposal, undefined, 2), { entry: 100, stop: 91, target: 119, inferred: false });
  });

  it("without a ticket, stop at the horizon distance with the recorded ATR and target at the minimum R:R", () => {
    const rejected = decision({ type: "screen_rejected", atr14: 2, horizon: "short" });
    assert.deepEqual(buyPlan(rejected, undefined, 2), { entry: 100, stop: 95, target: 110, inferred: true });
  });

  it("an entry without its own stop uses the plan of the proposal it cites, from its entry price", () => {
    const entry = decision({
      type: "entry",
      source: "portfolio-sync",
      price: 101,
      amount: 101,
      related_id: proposal.id,
    });
    assert.deepEqual(buyPlan(entry, proposal, 2), { entry: 101, stop: 91, target: 119, inferred: false });
  });

  it("if bought above the proposed target, the target moves to the minimum R:R", () => {
    const entry = decision({
      type: "entry",
      source: "portfolio-sync",
      price: 120,
      amount: 120,
      stop_initial: 100,
      related_id: proposal.id,
    });
    assert.deepEqual(buyPlan(entry, proposal, 2), { entry: 120, stop: 100, target: 160, inferred: true });
  });

  it("without stop or ATR there is no plan", () => {
    assert.equal(buyPlan(decision({ type: "screen_interesting" }), undefined, 2), null);
  });
});

describe("excursion", () => {
  const PLAN: BuyPlan = { entry: 100, stop: 90, target: 120, inferred: false };
  // The first row is the decision day (Tue 09-01): it does not count.
  const run = (rows: [number, number, number][], sessions?: number) =>
    excursion(ohlc("2026-09-01", rows), "2026-09-01", PLAN, sessions);

  it("target first: target R, maximum rise and fall in R", () => {
    const x = run([
      [100, 130, 80],
      [102, 105, 95],
      [98, 101, 92],
      [110, 121, 97],
    ])!;
    assert.equal(x.first, "target");
    assertClose(x.mfeR, 2.1);
    assertClose(x.maeR, -0.8);
    assert.equal(x.resultR, 2);
    assert.equal(x.sessions, 3);
  });

  it("stop first and then the target: −1R and the tightened-stop flag", () => {
    const x = run([
      [100, 100, 100],
      [95, 101, 89],
      [125, 125, 100],
    ])!;
    assert.equal(x.first, "stop");
    assert.equal(x.resultR, -1);
    assert.equal(x.targetAfterStop, true);
  });

  it("if the same session touches both, the stop counts", () => {
    const x = run([
      [100, 100, 100],
      [100, 121, 89],
    ])!;
    assert.equal(x.first, "stop");
    assert.equal(x.targetAfterStop, false);
  });

  it("touching neither: pending until the window completes, then the last close's R", () => {
    const rows: [number, number, number][] = [
      [100, 100, 100],
      [101, 105, 95],
      [103, 106, 99],
    ];
    assert.equal(run(rows)!.resultR, null);
    assert.equal(run(rows)!.first, null);
    assertClose(run(rows, 2)!.resultR, 0.3);
  });

  it("without any later session there is no path", () => {
    assert.equal(run([[100, 100, 100]]), null);
  });
});

// 25 sessions from Tue 09-01: the security rises 1 per session and the benchmark 0.5.
const AAA = weekdayBars(
  "2026-09-01",
  closes(25, (i) => 100 + i),
);
const VOO = weekdayBars(
  "2026-09-01",
  closes(25, (i) => 100 + i / 2),
);

describe("evaluateDecisions", () => {
  const evals = evaluateDecisions(
    [
      decision({ type: "screen_rejected", atr14: 2 }),
      decision({
        type: "deposit",
        ticker: null,
        price: undefined,
        amount: 50,
        origin: "propietario",
        source: "portfolio-sync",
      }),
      decision({ type: "hold" }),
    ],
    new Map([
      ["AAA", AAA],
      ["VOO", VOO],
    ]),
    FRAMEWORK,
  );

  it("follows decisions with an asset, not money flows", () => {
    assert.deepEqual(
      evals.map((e) => e.decision.type),
      ["screen_rejected", "hold"],
    );
  });

  it("20-session return and excess over the silo benchmark; 60 still partial", () => {
    const [rejected] = evals;
    assert.equal(rejected.reference, "VOO");
    assertClose(rejected.horizons[20].ret?.pct, 20);
    assert.equal(rejected.horizons[20].ret?.partial, false);
    assertClose(rejected.horizons[20].excess, 10);
    assert.equal(rejected.horizons[60].ret?.partial, true);
  });

  it("a screening rejection is measured against an inferred plan; a position hold has no plan", () => {
    const [rejected, hold] = evals;
    assert.deepEqual(rejected.plan, { entry: 100, stop: 94, target: 112, inferred: true });
    assert.equal(rejected.excursion?.first, "target");
    assertClose(rejected.excursion?.resultR, 2);
    assert.equal(hold.plan, null);
    assert.equal(hold.excursion, null);
  });

  it("groupStats only averages completed horizons", () => {
    const s = groupStats(evals);
    assert.equal(s.total, 2);
    assert.equal(s.horizons[20].complete, 2);
    assertClose(s.horizons[20].meanReturn, 20);
    assertClose(s.horizons[20].meanExcess, 10);
    assert.equal(s.horizons[60].complete, 0);
    assert.equal(s.horizons[60].meanReturn, null);
    assert.equal(s.withResult, 1);
    assert.equal(s.targetFirst, 1);
    assertClose(s.meanResultR, 2);
  });
});

// System trade under C v1: 10 units at 100 with 4 of tax, the proposal's stop
// at 90, sold at 120. Owner trade before C v1, with its own stop at 95, sold
// at 95.
const proposal = decision({
  type: "buy_proposal",
  assumptions: ["x"],
  stop_initial: 90,
  target: 130,
  rules_version: "1.0",
});
const entry = decision({
  type: "entry",
  source: "portfolio-sync",
  date: "2026-09-02",
  amount: 1000,
  costs: 4,
  related_id: proposal.id,
  rules_version: "1.0",
});
const exit = decision({
  type: "exit",
  source: "portfolio-sync",
  date: "2026-09-20",
  price: 120,
  amount: 1200,
  related_id: entry.id,
  rules_version: "1.0",
  // The snapshot of the lot (ADR-0015): the proposal's stop is resolved into `stop_initial`.
  entry_price: 100,
  stop_initial: 90,
  entry_units: 10,
  entry_costs: 4,
  entry_date: "2026-09-02",
  entry_origin: "sistema",
  entry_rules_version: "1.0",
  lot_units_left: 0,
});
const ownerEntry = decision({
  type: "entry",
  source: "portfolio-sync",
  origin: "propietario",
  ticker: "BBB",
  date: "2026-09-03",
  amount: 500,
  stop_initial: 95,
  rule_violations: ["entry_above_zone"],
});
const ownerExit = decision({
  type: "exit",
  source: "portfolio-sync",
  origin: "propietario",
  ticker: "BBB",
  date: "2026-09-10",
  price: 95,
  amount: 475,
  related_id: ownerEntry.id,
  entry_price: 100,
  stop_initial: 95,
  entry_units: 5,
  entry_date: "2026-09-03",
  entry_origin: "propietario",
  entry_rules_version: "0.4",
  rule_violations: ["entry_above_zone"],
  lot_units_left: 0,
});

/**
 * One exit of a lot: the snapshot of a 10-unit lot bought at 100 with the stop at 90, no costs. By
 * default it sells 4 units and leaves 6 in the lot; tests that sell the lot out say `lot_units_left: 0`.
 */
const lotExit = (fields: Partial<Decision> = {}): Decision =>
  decision({
    type: "exit",
    source: "portfolio-sync",
    ticker: "LOT",
    date: "2026-09-10",
    price: 120,
    amount: 480,
    related_id: "lot-a",
    entry_price: 100,
    stop_initial: 90,
    entry_units: 10,
    entry_date: "2026-08-03",
    entry_origin: "sistema",
    entry_rules_version: "1.0",
    lot_units_left: 6,
    ...fields,
  });
/** The exit that sells the whole 10-unit lot at 120. */
const fullExit = (fields: Partial<Decision> = {}): Decision => lotExit({ amount: 1200, lot_units_left: 0, ...fields });

describe("closedTrades", () => {
  it("R net of costs, measured from the exit alone: the entry and the proposal are not in the log", () => {
    const trades = closedTrades([ownerExit, exit]);
    // In the order the lots close: the owner's first.
    assert.deepEqual(
      trades.map((t) => t.ticker),
      ["BBB", "AAA"],
    );
    const [owner, system] = trades;
    assert.equal(system.stop, 90);
    // (120 − 100 − 0.40 tax per unit) / 10
    assertClose(system.rNet, 1.96);
    assert.equal(system.counts, true);
    assert.equal(system.entryDate, "2026-09-02");
    assert.equal(system.exitDate, "2026-09-20");
    assertClose(owner.rNet, -1);
    assert.equal(owner.counts, false, "owner's and before C v1: it does not count for the cutoff");
    assert.deepEqual(owner.ruleViolations, ["entry_above_zone"]);
  });

  it("counts for the cutoff from the origin and rules version of the snapshot, not of the exit", () => {
    const [t] = closedTrades([fullExit({ origin: "propietario", rules_version: "0.1" })]);
    assert.equal(t.counts, true);
    const [owner] = closedTrades([fullExit({ entry_origin: "propietario" })]);
    assert.equal(owner.counts, false);
    const [early] = closedTrades([fullExit({ entry_rules_version: "0.9" })]);
    assert.equal(early.counts, false);
  });

  it("without an initial stop R is not made up, and an exit without a snapshot is not a trade", () => {
    const trades = closedTrades([
      fullExit({ ticker: "CCC", stop_initial: undefined }),
      // Legacy exits cite their entry but carry no snapshot: no legacy path, they are skipped.
      decision({
        type: "exit",
        source: "portfolio-sync",
        ticker: "DDD",
        price: 110,
        amount: 110,
        related_id: entry.id,
      }),
      decision({ type: "exit", source: "portfolio-sync", ticker: "EEE", price: 110, amount: 110 }),
    ]);
    assert.equal(trades.length, 1);
    assert.equal(trades[0].ticker, "CCC");
    assert.equal(trades[0].rNet, null);
  });

  it("two partial exits of one lot are one trade: R = Σ(unitsᵢ / entry_units) × Rᵢ", () => {
    // 4 units at 120 (R = +2) and 6 at 105 (R = +0.5): 4/10 × 2 + 6/10 × 0.5 = 1.1.
    const trades = closedTrades([
      lotExit({ date: "2026-09-10", price: 120, amount: 480, lot_units_left: 6 }),
      lotExit({ date: "2026-09-17", price: 105, amount: 630, lot_units_left: 0 }),
    ]);
    assert.equal(trades.length, 1);
    assertClose(trades[0].rNet, 1.1);
    assert.equal(trades[0].exitDate, "2026-09-17", "the trade closes with its last exit");
    assert.equal(trades[0].exits.length, 2);
  });

  it("a lot that is not fully consumed is open, not a closed trade", () => {
    // 5 of 10 units sold.
    assert.deepEqual(closedTrades([lotExit({ price: 120, amount: 600, lot_units_left: 5 })]), []);
    // The same lot closes with the second exit.
    assert.equal(
      closedTrades([lotExit({ amount: 600, lot_units_left: 5 }), lotExit({ amount: 600, lot_units_left: 0 })]).length,
      1,
    );
  });

  it("amounts rounded to the cent do not make the lot's units left inconsistent", () => {
    // 10 units sold as 3.333333 + 6.666667 at 30.07: amounts rounded to cents.
    const part = (units: number) => Math.round(units * 30.07 * 100) / 100;
    const measured = measureTrades([
      lotExit({ entry_price: 30, stop_initial: 28, price: 30.07, amount: part(3.333333), lot_units_left: 6.666667 }),
      lotExit({ entry_price: 30, stop_initial: 28, price: 30.07, amount: part(6.666667), lot_units_left: 0 }),
    ]);
    assert.equal(measured.trades.length, 1);
    assert.deepEqual(measured.unmeasured.inconsistent, []);
  });

  it("two lots of one ticker are two trades, each with its own R", () => {
    const trades = closedTrades([
      fullExit({ related_id: "lot-a" }),
      fullExit({ related_id: "lot-b", entry_price: 110, stop_initial: 100 }),
    ]);
    assert.equal(trades.length, 2);
    assertClose(trades[0].rNet, 2);
    assertClose(trades[1].rNet, 1);
  });

  it("two lots with identical snapshots are two trades: the lot is its entry id", () => {
    // Two same-day buys at the same price and stop, each fully sold.
    const trades = closedTrades([fullExit({ related_id: "lot-a" }), fullExit({ related_id: "lot-b" })]);
    assert.equal(trades.length, 2);
    assertClose(trades[0].rNet, 2);
    assertClose(trades[1].rNet, 2);
  });

  it("an exit without an entry id is not measurable: the snapshot does not identify a lot", () => {
    assert.deepEqual(closedTrades([{ ...fullExit(), related_id: undefined }]), []);
  });

  it("a lot whose exits sell more than its units is not measured", () => {
    // 12 units sold of a 10-unit lot (a wrong entry_units, or exits of another lot): R would be 1.2x.
    assert.deepEqual(closedTrades([lotExit({ amount: 1440, lot_units_left: 0 })]), []);
    assert.deepEqual(
      closedTrades([lotExit({ amount: 600, lot_units_left: 5 }), lotExit({ amount: 840, lot_units_left: 0 })]),
      [],
    );
  });

  it("a sale of a lot with fractional units, its amount rounded to the cent, still closes it", () => {
    // 1.0004 units at 10.006; the full sale is 1.0004 units at 100: 100.04 to the cent.
    const trades = closedTrades([
      lotExit({
        entry_price: 10.006,
        stop_initial: 9,
        entry_units: 1.0004,
        price: 100,
        amount: 100.04,
        lot_units_left: 0,
      }),
    ]);
    assert.equal(trades.length, 1);
  });

  describe("closure by lot_units_left (#52)", () => {
    it("a lot is closed when its last exit has lot_units_left = 0, however the units add up", () => {
      const [t] = closedTrades([
        lotExit({ amount: 480, lot_units_left: 6 }),
        lotExit({ amount: 720, lot_units_left: 0 }),
      ]);
      assert.equal(t.exits.length, 2);
      // 6 units left after the first exit and 6 sold by the second: closed.
      assert.deepEqual(closedTrades([lotExit({ amount: 480, lot_units_left: 6 })]), []);
    });

    it("a low-priced lot with a real remainder is open: the summed-units slack of #40 would have closed it", () => {
      // 100 units at 0.02 (stop 0.01); 49 + 50 units sold at 0.01 leave 1 unit: the old slack was 1.25 units.
      const part = (units: number, left: number) =>
        lotExit({
          entry_price: 0.02,
          stop_initial: 0.01,
          entry_units: 100,
          price: 0.01,
          amount: units * 0.01,
          lot_units_left: left,
        });
      const measured = measureTrades([part(49, 51), part(50, 1)]);
      assert.deepEqual(measured.trades, []);
      assert.deepEqual(measured.unmeasured.inconsistent, []);
      assert.deepEqual(measured.unmeasured.oversold, []);
      assert.equal(measureTrades([part(49, 51), part(51, 0)]).trades.length, 1);
    });

    it("the exits are followed in date order, whatever their order in the log", () => {
      const measured = measureTrades([
        lotExit({ date: "2026-09-17", amount: 720, lot_units_left: 0 }),
        lotExit({ date: "2026-09-10", amount: 480, lot_units_left: 6 }),
      ]);
      assert.equal(measured.trades.length, 1);
      assert.equal(measured.trades[0].exitDate, "2026-09-17");
      assert.deepEqual(measured.unmeasured.inconsistent, []);
    });

    it("a lot whose lot_units_left does not drop by the units each exit sold is not measured, and named", () => {
      // 4 units sold but the lot says 9 left (a unit is missing): the other exit is fine.
      const measured = measureTrades([
        lotExit({ amount: 480, lot_units_left: 9 }),
        lotExit({ amount: 720, lot_units_left: 0 }),
        fullExit({ ticker: "OK", related_id: "lot-ok" }),
      ]);
      assert.deepEqual(
        measured.trades.map((t) => t.ticker),
        ["OK"],
      );
      assert.deepEqual(measured.unmeasured.inconsistent, [
        { currency: "USD", ticker: "LOT", lotId: "lot-a", reason: "units_left" },
      ]);
    });

    it("an exit that leaves more in the lot than the previous one is not measured", () => {
      const measured = measureTrades([
        lotExit({ date: "2026-09-10", amount: 480, lot_units_left: 6 }),
        lotExit({ date: "2026-09-17", amount: 120, lot_units_left: 6 }),
      ]);
      assert.deepEqual(measured.trades, []);
      assert.equal(measured.unmeasured.inconsistent[0]?.reason, "units_left");
    });

    it("exits of one lot that disagree on the snapshot are not measured, and named", () => {
      for (const change of [
        { entry_price: 101 },
        { stop_initial: 91 },
        { entry_units: 11 },
        { entry_date: "2026-08-04" },
        { entry_origin: "propietario" as const },
        { entry_rules_version: "1.1" },
        { rule_violations: ["no_stop"] },
      ] satisfies Partial<Decision>[]) {
        const measured = measureTrades([
          lotExit({ amount: 480, lot_units_left: 6 }),
          lotExit({ amount: 720, lot_units_left: 0, ...change }),
        ]);
        assert.deepEqual(measured.trades, [], JSON.stringify(change));
        assert.deepEqual(
          measured.unmeasured.inconsistent,
          [{ currency: "USD", ticker: "LOT", lotId: "lot-a", reason: "snapshot" }],
          JSON.stringify(change),
        );
      }
    });

    it("the entry costs differ between exits by design and are not a disagreement", () => {
      const measured = measureTrades([
        lotExit({ amount: 480, lot_units_left: 6, entry_costs: 1.6 }),
        lotExit({ amount: 720, lot_units_left: 0, entry_costs: 2.4 }),
      ]);
      assert.equal(measured.trades.length, 1);
      assert.deepEqual(measured.unmeasured.inconsistent, []);
    });

    it("an exit with the snapshot but no lot_units_left is an exit without a snapshot: counted and named", () => {
      const { lot_units_left: _left, ...noLeft } = fullExit();
      const measured = measureTrades([noLeft]);
      assert.deepEqual(measured.trades, []);
      assert.deepEqual(measured.unmeasured.exitsWithoutSnapshot, [
        { currency: "USD", ticker: "LOT", date: "2026-09-10", lotId: "lot-a" },
      ]);
    });

    it("a lot with one exit that has no lot_units_left and a later one that has it is not measured as if it were whole", () => {
      const { lot_units_left: _left, ...noLeft } = lotExit({ date: "2026-09-10", amount: 480 });
      const measured = measureTrades([noLeft, lotExit({ date: "2026-09-17", amount: 720, lot_units_left: 0 })]);
      assert.deepEqual(measured.trades, [], "6 units were sold by the later exit alone: the lot does not add up");
      assert.equal(measured.unmeasured.exitsWithoutSnapshot.length, 1);
      assert.equal(measured.unmeasured.inconsistent.length + measured.unmeasured.oversold.length, 1);
    });
  });

  it("entry_costs of an exit are its share of the lot's entry costs: R is the same as spread over the lot", () => {
    // Lot of 10 units with 4 of entry costs: 4 units sold carry 1.6, the last 6 carry the remaining 2.4.
    const trades = closedTrades([
      lotExit({ price: 120, amount: 480, entry_costs: 1.6, lot_units_left: 6 }),
      lotExit({ price: 105, amount: 630, entry_costs: 2.4, lot_units_left: 0 }),
    ]);
    // 4/10 × (20 − 0.4) / 10 + 6/10 × (5 − 0.4) / 10
    assertClose(trades[0].rNet, 0.4 * 1.96 + 0.6 * 0.46);
  });

  it("the costs of the sale are subtracted per unit sold", () => {
    const withCosts = closedTrades([fullExit({ costs: 10 })]);
    // (120 − 100 − 1 per unit) / 10
    assertClose(withCosts[0].rNet, 1.9);
  });

  it("the counter starts with the first entry under C v1", () => {
    assert.equal(counterStart([ownerEntry, entry]), "2026-09-02");
    assert.equal(counterStart([ownerEntry]), null);
  });
});

// From Mon 08-31 to Fri 09-25, all flat at 100. Today's USD cash: 2,000 to start
// − 1,004 − 500 + 475 + 1,200.
const FLAT = weekdayBars(
  "2026-08-31",
  closes(20, () => 100),
);
const INPUT: EvaluationInput = {
  decisions: [proposal, entry, ownerEntry, ownerExit, exit],
  portfolios: { EUR: snapshot("EUR", 500), USD: snapshot("USD", 2171) },
  bars: new Map([
    ["EXSA.DE", FLAT],
    ["VOO", FLAT],
    ["AAA", FLAT],
    ["BBB", FLAT],
  ]),
  asOf: "2026-09-25",
  rulesVersion: "1.0",
  eurUsd: 1.25,
  framework: FRAMEWORK,
};

describe("unmeasured exits and lots", () => {
  const bare = (ticker: string, fields: Partial<Decision> = {}) =>
    decision({
      type: "exit",
      source: "portfolio-sync",
      ticker,
      date: "2026-09-12",
      price: 110,
      amount: 110,
      related_id: "gone",
      ...fields,
    });
  const withBoard = (decisions: Decision[], language: typeof es = es) => {
    const report = buildEvaluationReport({ ...INPUT, decisions });
    return { report, board: extractCutBoard(renderDecisionsEvaluation(report, language))! };
  };

  it("counts the exits without a lot snapshot and names each one: ticker, date and the lot it cites", () => {
    const measured = measureTrades([bare("DDD"), fullExit(), bare("EEE", { related_id: undefined })]);
    assert.deepEqual(measured.unmeasured.exitsWithoutSnapshot, [
      { currency: "USD", ticker: "DDD", date: "2026-09-12", lotId: "gone" },
      { currency: "USD", ticker: "EEE", date: "2026-09-12" },
    ]);
    assert.equal(measured.trades.length, 1, "the measurable lot is still measured");

    const { board } = withBoard([bare("DDD"), fullExit(), bare("EEE", { related_id: undefined })]);
    assert.match(board, /Salidas y lotes sin medir\n> - 2 salidas sin instantánea del lote/);
    assert.match(board, /> - DDD, 2026-09-12, lote gone$/m);
    assert.match(board, /> - EEE, 2026-09-12$/m);
    assert.equal(board.match(/sin instantánea/g)?.length, 1);
  });

  it("names the first skipped exits and counts the rest: until #44 every real exit is skipped", () => {
    const many = Array.from({ length: 13 }, (_, i) => bare(`T${i}`));
    const { report, board } = withBoard(many);
    const warning = report.board.warnings.find((w) => w.kind === "exitsWithoutSnapshot");
    assert.equal(warning?.kind === "exitsWithoutSnapshot" && warning.exits.length, 13, "all of them are in the data");
    assert.match(board, /13 salidas sin instantánea del lote/);
    assert.match(board, /> - T9, /);
    assert.doesNotMatch(board, /> - T10, /);
    assert.match(board, /y 3 más/);
  });

  it("names an oversold lot by ticker and entry id, and a measured trade stays measured", () => {
    // Lot-a is a clean 10-unit lot; lot-b sells 12 units of a 10-unit lot.
    const decisions = [fullExit(), fullExit({ ticker: "OVR", related_id: "lot-b", amount: 1440 })];
    const measured = measureTrades(decisions);
    assert.deepEqual(measured.unmeasured.oversold, [{ currency: "USD", ticker: "OVR", lotId: "lot-b" }]);
    assert.deepEqual(measured.unmeasured.exitsWithoutSnapshot, []);
    assert.deepEqual(
      measured.trades.map((t) => t.ticker),
      ["LOT"],
    );

    const { board } = withBoard(decisions);
    assert.match(board, /> - OVR, lote lot-b: sus ventas suman más unidades que la compra/);
    assert.doesNotMatch(board, /sin instantánea/);
  });

  it("a lot whose exits do not add up is a warning of its own kind, as data, in both languages", () => {
    const decisions = [
      fullExit(),
      lotExit({ ticker: "BAD", related_id: "lot-c", amount: 480, lot_units_left: 9 }),
      lotExit({ ticker: "DIS", related_id: "lot-d", amount: 480, lot_units_left: 6 }),
      lotExit({ ticker: "DIS", related_id: "lot-d", amount: 720, lot_units_left: 0, entry_price: 101 }),
    ];
    const { report } = withBoard(decisions);
    assert.deepEqual(
      report.board.warnings.find((w) => w.kind === "inconsistentLots"),
      {
        kind: "inconsistentLots",
        lots: [
          { currency: "USD", ticker: "BAD", lotId: "lot-c", reason: "units_left" },
          { currency: "USD", ticker: "DIS", lotId: "lot-d", reason: "snapshot" },
        ],
      },
    );
    const spanish = extractCutBoard(renderDecisionsEvaluation(report, es))!;
    assert.match(spanish, /> - BAD, lote lot-c: /);
    assert.match(spanish, /> - DIS, lote lot-d: /);
    const english = extractCutBoard(renderDecisionsEvaluation(report, en))!;
    assert.match(english, /> - BAD, lot lot-c: /);
    assert.match(english, /> - DIS, lot lot-d: /);
    assert.equal(report.board.trades.total, 1, "the consistent lot is still measured");
  });

  it("the unmeasured kinds sit under one heading, grouped by kind, not by comparing translated titles", () => {
    const { report } = withBoard([
      bare("DDD"),
      fullExit({ ticker: "OVR", amount: 1440 }),
      lotExit({ ticker: "BAD", related_id: "lot-c", amount: 480, lot_units_left: 9 }),
    ]);
    for (const m of [en, es]) {
      const groups = boardWarnings(report.board, m).filter((g) => g.title !== m.evaluation.reconstructionMismatch);
      assert.equal(groups.length, 1, "one heading");
      assert.equal(groups[0].title, m.evaluation.unmeasured.title);
      assert.equal(groups[0].lines.length, 4, "the count and the exit, the oversold lot, the inconsistent lot");
    }
  });

  it("every kind goes through the board's one warnings list, as structured data", () => {
    const { report } = withBoard([bare("DDD"), fullExit({ ticker: "OVR", amount: 1440 })]);
    const unmeasured = report.board.warnings.filter((w) => w.kind !== "reconstruction");
    assert.deepEqual(unmeasured[0], {
      kind: "exitsWithoutSnapshot",
      exits: [{ currency: "USD", ticker: "DDD", date: "2026-09-12", lotId: "gone" }],
    });
    assert.deepEqual(unmeasured[1], {
      kind: "oversoldLots",
      lots: [{ currency: "USD", ticker: "OVR", lotId: "lot-a" }],
    });
  });

  it("the silo reconstruction warnings travel in the same list, rendered in the renderer's language", () => {
    const board = buildCutBoard({ ...INPUT, bars: new Map() });
    const siloLines = board.silos.flatMap((s) => s.warnings);
    assert.ok(siloLines.length > 0, "without bars the silos cannot be reconstructed");
    assert.deepEqual(board.warnings, [{ kind: "reconstruction", lines: siloLines }]);
    assert.equal(boardWarnings(board, en)[0].title, en.evaluation.reconstructionMismatch);
    assert.equal(boardWarnings(board, es)[0].title, es.evaluation.reconstructionMismatch);
  });

  it("the warnings are put into words by the renderer, in its language", () => {
    const { report } = withBoard([bare("DDD"), fullExit({ ticker: "OVR", amount: 1440 })]);
    const english = extractCutBoard(renderDecisionsEvaluation(report, en))!;
    assert.match(english, /Some exits and lots were not measured/);
    assert.match(english, /1 exit without a lot snapshot/);
    assert.match(english, /DDD, 2026-09-12, lot gone/);
    assert.match(english, /OVR, lot lot-a/);
    const spanish = boardWarnings(report.board, es).find((g) => g.title === es.evaluation.unmeasured.title);
    assert.equal(spanish?.lines.length, 3, "the count, the exit and the oversold lot share one heading");
  });

  it("an exit with no ticker is counted without a snapshot, never shown as undefined", () => {
    const noTicker = { ...fullExit(), ticker: undefined } as unknown as Decision;
    const measured = measureTrades([noTicker]);
    assert.equal(measured.unmeasured.exitsWithoutSnapshot.length, 1);
    assert.deepEqual(measured.unmeasured.oversold, []);
    const { board } = withBoard([noTicker]);
    assert.doesNotMatch(board, /undefined/);
  });

  it("a clean log reports nothing and its numbers do not change", () => {
    const measured = measureTrades(INPUT.decisions);
    assert.deepEqual(measured.unmeasured, { exitsWithoutSnapshot: [], oversold: [], inconsistent: [] });
    const { report, board } = withBoard([...INPUT.decisions]);
    assert.deepEqual(report.board.warnings, []);
    assert.deepEqual(boardWarnings(report.board), []);
    assert.doesNotMatch(board, /sin medir/);
    assert.equal(report.board.trades.total, 1);
    assertClose(report.board.trades.expectancy, 1.96);
  });
});

describe("buildCutBoard", () => {
  it("counts the system trades under C v1 and compares real and shadow portfolios in EUR", () => {
    const board = buildCutBoard(INPUT);
    assert.equal(board.counterStart, "2026-09-02");
    assert.equal(board.measuredFrom, "2026-09-02");
    assert.deepEqual(
      { ...board.trades, expectancy: Number(board.trades.expectancy!.toFixed(6)) },
      { total: 1, withR: 1, expectancy: 1.96, winners: 1 },
    );
    assert.equal(board.open, 0);

    const usd = board.silos.find((s) => s.currency === "USD")!;
    assertClose(usd.real, 2171, 1e-6);
    assertClose(usd.shadow, 2000, 1e-6);
    assert.deepEqual(
      board.silos.flatMap((s) => s.warnings),
      [],
    );
    assertClose(board.totalEur?.real, 500 + 2171 / 1.25, 1e-6);
    assertClose(board.totalEur?.shadow, 500 + 2000 / 1.25, 1e-6);
  });

  it("before C v1 measures in rehearsal from the first decision in the log", () => {
    const board = buildCutBoard({
      ...INPUT,
      decisions: [ownerEntry, ownerExit],
      rulesVersion: "0.4",
      portfolios: { EUR: snapshot("EUR", 500), USD: snapshot("USD", 1975) },
    });
    assert.equal(board.counterStart, null);
    assert.equal(board.measuredFrom, "2026-09-03");
    assert.equal(board.trades.total, 0);
  });

  it("without an EUR/USD rate there is no EUR total", () => {
    assert.equal(buildCutBoard({ ...INPUT, eurUsd: null }).totalEur, null);
  });
});

describe("decisionGroupings", () => {
  it("splits the screening into ranking and exploration; drawn ones go in neither (ADR-0012)", () => {
    const screen = (fields: Partial<Decision>) => decision({ type: "screen_rejected", source: "screening", ...fields });
    const evals = evaluateDecisions(
      [
        screen({ ticker: "RANKED", rank: 1, score: 1 }),
        screen({ ticker: "EXPLORED", rank: 40, score: 0.2, exploration: true }),
        screen({ ticker: "DRAWN" }),
      ],
      new Map(),
      FRAMEWORK,
    );
    const grouping = decisionGroupings(evals).find((g) => g.title === "Screening: ranking frente a exploración")!;
    assert.deepEqual(
      grouping.groups.map((g) => [g.label, g.items.map((e) => e.decision.ticker)]),
      [
        ["Ranking", ["RANKED"]],
        ["Exploración", ["EXPLORED"]],
      ],
    );
  });

  it("groups the interesting ones by rubric conviction, only since the engine computes it", () => {
    const interesting = (ticker: string, fields: Partial<Decision>) =>
      decision({ type: "screen_interesting", source: "screening", ticker, ...fields });
    const evals = evaluateDecisions(
      [
        interesting("HIGH", { conviction: "high", rules_version: "0.8" }),
        interesting("LOW", { conviction: "low", rules_version: "1.0" }),
        interesting("LLM", { conviction: "medium", rules_version: "0.7" }),
      ],
      new Map(),
      FRAMEWORK,
    );
    const grouping = decisionGroupings(evals).find((g) => g.title === "Screening: interesantes por convicción")!;
    assert.deepEqual(
      grouping.groups.map((g) => [g.label, g.items.map((e) => e.decision.ticker)]),
      [
        ["high", ["HIGH"]],
        ["medium", []],
        ["low", ["LOW"]],
      ],
    );
  });

  it("groups the engine's buys by their conviction; the reasoner's stays apart", () => {
    const buy = (ticker: string, fields: Partial<Decision>) =>
      decision({
        type: "buy_blocked",
        ticker,
        price: 100,
        eligibility: { verdict: "blocked", reasons: ["rr_below_min"] },
        ...fields,
      });
    const evals = evaluateDecisions(
      [
        buy("ENGINE", { conviction: "medium", conviction_points: ["regime_favorable", "reward_risk"] }),
        buy("ZERO", { conviction: "low", conviction_points: [] }),
        buy("LLM", { conviction: "medium" }),
        buy("NONE", {}),
      ],
      new Map(),
      FRAMEWORK,
    );
    const grouping = decisionGroupings(evals).find((g) => g.title === "Propuestas de compra por convicción")!;
    assert.deepEqual(
      grouping.groups.map((g) => [g.label, g.items.map((e) => e.decision.ticker)]),
      [
        ["high", []],
        ["medium", ["ENGINE"]],
        ["low", ["ZERO"]],
        ["sin convicción del motor", ["LLM", "NONE"]],
      ],
    );
  });

  it("splits the blocked ones into two disjoint groups: by regime and by other reasons", () => {
    const blocked = (ticker: string, reasons: string[]) =>
      decision({ type: "buy_blocked", ticker, price: 100, eligibility: { verdict: "blocked", reasons } });
    const evals = evaluateDecisions(
      [blocked("REGIME", ["trend_bearish", "regime_adverse"]), blocked("RR", ["rr_below_min"])],
      new Map(),
      FRAMEWORK,
    );
    const grouping = decisionGroupings(evals).find((g) => g.title === "Elegibles frente a bloqueadas")!;
    const tickers = (label: string) =>
      grouping.groups.find((g) => g.label === label)!.items.map((e) => e.decision.ticker);
    // No decision counts in both rows: the control does not contain what is measured.
    assert.deepEqual(tickers("Bloqueadas por régimen"), ["REGIME"]);
    assert.deepEqual(tickers("Bloqueadas por otros motivos"), ["RR"]);
    assert.equal(
      grouping.groups.some((g) => g.label === "Bloqueadas"),
      false,
    );
  });
});

describe("evaluationSymbols", () => {
  it("each asset in the log and in portfolio.md, and each silo benchmark, without repeats", () => {
    const portfolios = {
      EUR: {
        ...snapshot("EUR", 0),
        positions: [
          {
            ticker: "SAN.MC",
            currency: "EUR" as const,
            volume: 1,
            avgPrice: 1,
            currentPrice: 1,
            pl: 0,
            stopLoss: null,
          },
        ],
      },
      USD: snapshot("USD", 0),
    };
    assert.deepEqual(evaluationSymbols([entry, exit, ownerEntry], portfolios, FRAMEWORK), [
      "AAA",
      "BBB",
      "SAN.MC",
      "EXSA.DE",
      "VOO",
    ]);
  });
});

describe("renderDecisionsEvaluation", () => {
  const report = buildEvaluationReport(INPUT);
  const md = renderDecisionsEvaluation(report);

  it("the cutoff table is the first section, and extractCutBoard pulls it out without the rest", () => {
    assert.equal(md.indexOf("\n## "), md.indexOf(`\n${CUT_BOARD_HEADING}`));
    const board = extractCutBoard(md)!;
    assert.match(
      board,
      /\| Operaciones cerradas del sistema bajo C v1 \| 1 \| revisión a las 30, decisión a las 50 \|/,
    );
    assert.match(board, /\| Esperanza, R neta \| \+1\.96R en 1 \(1\/1 ganadoras\) \| > 0R \|/);
    assert.match(board, /\| USD \| VOO \| 2026-09-02 \| 2171\.00 \| 2000\.00 \| \+171\.00 \|/);
    assert.match(board, /Muestra pequeña/);
    assert.doesNotMatch(board, /Cómo leerlo|Detalle por decisión|## /);
  });

  it("carries closed trades, aggregates and per-decision detail", () => {
    assert.match(md, /\| Contador del corte \(sistema, C v1\) \| 1 \| 1 \| \+1\.96R \| 1\/1 \|/);
    assert.match(md, /\| Propietario, incumpliendo reglas \| 1 \| 1 \| -1\.00R \| 0\/1 \|/);
    // Entry date, rules version and rule breaks come from the exit's snapshot.
    assert.match(
      md,
      /\| 2026-09-03 \| 2026-09-10 \| BBB \| USD \| propietario \| 0\.4 \| entry_above_zone \| 95\.00 \| -1\.00R \|/,
    );
    assert.match(md, /\| 2026-09-02 \| 2026-09-20 \| AAA \| USD \| sistema ✓ \| 1\.0 \| — \| 90\.00 \| \+1\.96R \|/);
    assert.match(md, /### Elegibles frente a bloqueadas/);
    assert.match(md, /\| 2026-09-01 \| AAA \| buy_proposal \| sistema \| — \| 1\.0 \| 100\.00 \|/);
  });

  it("warns about a silo drawdown pause", () => {
    const paused = structuredClone(report);
    paused.board.silos[0].drawdown = { currentPct: 16.2, maxPct: 16.2, peakDate: "2026-09-04" };
    assert.match(extractCutBoard(renderDecisionsEvaluation(paused))!, /Pausa por caída en el silo EUR/);
  });

  it("counter not started: says so and marks the measurement as rehearsal", () => {
    const trial = renderDecisionsEvaluation(
      buildEvaluationReport({ ...INPUT, decisions: [ownerEntry, ownerExit], rulesVersion: "0.4" }),
    );
    assert.match(
      extractCutBoard(trial)!,
      /Contador sin empezar[\s\S]*en ensayo\*\* desde el inicio del registro \(2026-09-03\)/,
    );
  });

  it("empty log: the table exists anyway and says so", () => {
    const empty = renderDecisionsEvaluation(buildEvaluationReport({ ...INPUT, decisions: [] }));
    assert.equal(extractCutBoard(empty), "Registro vacío: todavía no hay decisiones que medir.");
  });

  it("in English, with the same cut board heading", () => {
    const english = renderDecisionsEvaluation(report, en);
    assert.match(english, /^title: "Decision evaluation — cut board"$/m);
    assert.match(extractCutBoard(english)!, /^\| Indicator \| Value \| Criterion \(ADR-0009 §4\) \|$/m);
    assert.match(english, /\| Expectancy, net R \| \+1\.96R over 1 \(1\/1 winners\) \| > 0R \|/);
    assert.match(english, /\| Owner, breaking rules \| 1 \| 1 \| -1\.00R \| 0\/1 \|/);
    assert.match(english, /## How to read it[\s\S]*## Closed trades[\s\S]*## Aggregates[\s\S]*## Detail by decision/);
    assert.match(english, /Return at 20 and 60 sessions/);
    assert.doesNotMatch(english, SPANISH);
  });

  it("extractCutBoard returns null if the report has no table", () => {
    assert.equal(extractCutBoard("# Otro fichero\n"), null);
  });
});
