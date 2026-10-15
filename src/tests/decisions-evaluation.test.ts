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
  type BuyPlan,
  type EvaluationFramework,
  type EvaluationInput,
} from "../utils/decisions-evaluation.js";
import { CUT_BOARD_HEADING, extractCutBoard, renderDecisionsEvaluation } from "../utils/decisions-evaluation-render.js";
import type { HistoricalBar } from "../providers/types.js";
import type { Currency, PortfolioSnapshot } from "../types.js";
import { closes, weekdayBars } from "./fixtures/weekday-bars.js";
import { en } from "../i18n/en.js";
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
});

describe("closedTrades", () => {
  it("R net of costs, with the proposal's stop if the entry does not carry its own", () => {
    const trades = closedTrades([proposal, entry, ownerEntry, ownerExit, exit]);
    // In exit order: the owner's closed first.
    assert.deepEqual(
      trades.map((t) => t.entry.ticker),
      ["BBB", "AAA"],
    );
    const [owner, system] = trades;
    assert.equal(system.stop, 90);
    // (120 − 100 − 0.40 tax per unit) / 10
    assertClose(system.rNet, 1.96);
    assert.equal(system.counts, true);
    assertClose(owner.rNet, -1);
    assert.equal(owner.counts, false, "owner's and before C v1: it does not count for the cutoff");
  });

  it("without an initial stop R is not made up, and an exit without an entry is not a trade", () => {
    const noStop = decision({ type: "entry", source: "portfolio-sync", ticker: "CCC", amount: 100 });
    const trades = closedTrades([
      noStop,
      decision({
        type: "exit",
        source: "portfolio-sync",
        ticker: "CCC",
        price: 110,
        amount: 110,
        related_id: noStop.id,
      }),
      decision({ type: "exit", source: "portfolio-sync", ticker: "DDD", price: 110, amount: 110 }),
    ]);
    assert.equal(trades.length, 1);
    assert.equal(trades[0].rNet, null);
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
