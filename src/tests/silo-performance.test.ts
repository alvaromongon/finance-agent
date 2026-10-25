/**
 * Tests of utils/silo-performance.ts: real value rebuilt from
 * portfolio.md and the log, shadow portfolio with deposits and conversions,
 * drawdown net of flows and money-weighted return. No network.
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDecision, type Decision } from "../decisions.js";
import {
  drawdown,
  flowAmount,
  moneyWeightedReturn,
  reconstructSilo,
  shadowValue,
  siloPerformance,
  type SiloInput,
} from "../utils/silo-performance.js";
import type { Currency, PortfolioSnapshot, Position } from "../types.js";
import { weekdayBars } from "./fixtures/weekday-bars.js";
import { parseTicker as tk } from "../ticker.js";

function assertClose(actual: number | null | undefined, expected: number, epsilon = 1e-6) {
  assert.ok(actual != null && Math.abs(actual - expected) < epsilon, `expected ${expected}, got ${actual}`);
}

const decision = (fields: Partial<Decision> & Pick<Decision, "type" | "date">): Decision =>
  buildDecision({
    ticker: null,
    currency: "EUR",
    origin: "propietario",
    source: "portfolio-sync",
    rules_version: "0.4",
    ...fields,
  });

const snapshot = (currency: Currency, cash: number, positions: Position[] = []): PortfolioSnapshot => ({
  currency,
  cash,
  positions,
  lots: [],
  syncedAt: "2026-09-10",
});

// Thu 09-03 … Thu 09-10. The start is Monday 09-07: the starting point is
// Sunday 09-06, with Friday's closes.
const START = "2026-09-07";
const AS_OF = "2026-09-10";
const BARS = new Map([
  ["EXSA.DE", weekdayBars("2026-09-03", [100, 100, 100, 110, 110, 99])],
  ["VOO", weekdayBars("2026-09-03", [200, 200, 200, 200, 210, 210])],
  ["AAA", weekdayBars("2026-09-03", [50, 50, 50, 60, 70, 55])],
]);

// EUR silo: €1,000 at the start; deposits 100 on Monday, buys 5 AAA at 60 on
// Tuesday and converts €100 to USD on Wednesday (€0.5 fee, 1.2 $/€).
const DECISIONS = [
  decision({ type: "deposit", date: "2026-09-01", amount: 999 }), // before the start: already in the base cash
  decision({ type: "deposit", date: "2026-09-07", amount: 100 }),
  decision({ type: "entry", date: "2026-09-08", ticker: tk("AAA"), price: 60, amount: 300 }),
  decision({ type: "fx_conversion", date: "2026-09-09", amount: 100, costs: 0.5, fx_rate: 1.2 }),
];

const AAA_POSITION: Position = {
  ticker: tk("AAA"),
  currency: "EUR",
  volume: 5,
  avgPrice: 60,
  currentPrice: 55,
  pl: -25,
  stopLoss: null,
};
const EUR_TODAY = snapshot("EUR", 700, [AAA_POSITION]);
// USD: $500 from before plus the $119.40 that arrived from the conversion.
const USD_TODAY = snapshot("USD", 619.4);

const input = (overrides: Partial<SiloInput> = {}): SiloInput => ({
  currency: "EUR",
  portfolio: EUR_TODAY,
  decisions: DECISIONS,
  start: START,
  asOf: AS_OF,
  bars: BARS,
  reference: "EXSA.DE",
  ...overrides,
});

describe("flowAmount", () => {
  it("deposit and withdrawal in their silo; the conversion leaves the source and arrives net at the other", () => {
    const fx = DECISIONS[3];
    assert.equal(flowAmount(DECISIONS[1], "EUR"), 100);
    assert.equal(flowAmount(DECISIONS[1], "USD"), null);
    assert.equal(flowAmount(decision({ type: "withdrawal", date: START, amount: 40 }), "EUR"), -40);
    assert.equal(flowAmount(fx, "EUR"), -100);
    assertClose(flowAmount(fx, "USD"), 119.4);
  });

  it("a buy is not a flow: the money does not leave the silo", () => {
    assert.equal(flowAmount(DECISIONS[2], "EUR"), null);
  });
});

describe("reconstructSilo", () => {
  it("undoes from portfolio.md down to the base close and values each session at the close", () => {
    const history = reconstructSilo(input());

    assert.deepEqual(history.base, { date: "2026-09-06", value: 1000 });
    assert.deepEqual(
      history.days.map((d) => d.date),
      ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10"],
    );
    // 1,100 after the deposit; 800 cash + 5 × 60; 700 + 5 × 70; 700 + 5 × 55.
    history.days.forEach((d, i) => {
      assertClose(d.value, [1100, 1100, 1050, 975][i]);
    });
    assert.deepEqual(
      history.days.map((d) => d.flow),
      [100, 0, -100, 0],
    );
    assert.deepEqual(history.flows, [
      { date: "2026-09-07", amount: 100 },
      { date: "2026-09-09", amount: -100 },
    ]);
    assert.deepEqual(history.warnings, []);
  });

  it("uses portfolio.md total cash, not the available balance", () => {
    const history = reconstructSilo(input({ portfolio: { ...EUR_TODAY, cash: 133, totalCash: 700 } }));
    assert.equal(history.base.value, 1000);
  });

  it("an exit's units are its `units`, not amount / price: a rounded amount does not move the position", () => {
    // 10 units bought at 0.001 and 6 sold (the amount rounded to the cent, 0.01 / 0.001 would read 10): 4 are left.
    const decisions = [
      decision({ type: "entry", date: "2026-09-08", ticker: tk("AAA"), price: 0.001, amount: 0.01, units: 10 }),
      decision({ type: "exit", date: "2026-09-09", ticker: tk("AAA"), price: 0.001, amount: 0.01, units: 6 }),
    ];
    const history = reconstructSilo(
      input({ decisions, portfolio: snapshot("EUR", 700, [{ ...AAA_POSITION, volume: 4 }]) }),
    );
    assert.deepEqual(history.warnings, []);
    // Nothing was held before the purchase: the base is the cash alone (4 units read back would be 4 × 50 more).
    assertClose(history.base.value, 700);
  });

  it("warns if the log does not match portfolio.md", () => {
    const fewerUnits = reconstructSilo(input({ portfolio: snapshot("EUR", 700, [{ ...AAA_POSITION, volume: 3 }]) }));
    assert.deepEqual(fewerUnits.warnings, [
      { kind: "oversold", currency: "EUR", ticker: "AAA", units: -2, start: "2026-09-07" },
    ]);

    const unrecordedDeposit = reconstructSilo(
      input({ decisions: [...DECISIONS, decision({ type: "deposit", date: "2026-09-08", amount: 2000 })] }),
    );
    // The log holds a 2,000 deposit that today's cash does not show: the base cash would be 1,000 − 2,000.
    assert.deepEqual(unrecordedDeposit.warnings, [
      { kind: "negativeCash", currency: "EUR", start: "2026-09-07", cash: -1000 },
    ]);
  });

  it("without closes for an asset values it at the last known price and warns", () => {
    const history = reconstructSilo(input({ bars: new Map([["EXSA.DE", BARS.get("EXSA.DE")!]]) }));
    assertClose(history.days.at(-1)?.value, 975, 1e-9);
    assert.deepEqual(history.warnings, [{ kind: "missingCloses", currency: "EUR", tickers: ["AAA"] }]);
  });
});

describe("drawdown", () => {
  it("measures the drawdown net of flows: the conversion does not count as a loss", () => {
    const dd = drawdown(reconstructSilo(input()));
    // Peak after the 09-09 session (+4.5% net of flows); then 1,050 → 975.
    assert.equal(dd.peakDate, "2026-09-09");
    assertClose(dd.currentPct, (1 - 975 / 1050) * 100);
    assertClose(dd.maxPct, dd.currentPct);
    // The raw value would fall from 1,100 to 975, 11.4%.
    assert.ok(dd.currentPct < 8);
  });

  it("an empty silo receiving its first deposit has no drawdown", () => {
    const dd = drawdown({
      base: { date: "2026-09-04", value: 0 },
      days: [{ date: "2026-09-07", value: 50, flow: 50 }],
    });
    assert.equal(dd.currentPct, 0);
  });
});

describe("shadow portfolio", () => {
  it("EUR: starts with the base value and replays the deposit and the conversion in the benchmark", () => {
    const history = reconstructSilo(input());
    // 10 units at 100; +1 for the deposit; −0.909 for the conversion at 110; at 99 today.
    assertClose(shadowValue(history.base, history.flows, BARS.get("EXSA.DE")!, AS_OF), 999);
  });

  it("USD: the conversion buys the benchmark with the dollars received, already net of the fee", () => {
    const history = reconstructSilo(input({ currency: "USD", portfolio: USD_TODAY, reference: "VOO" }));
    assert.equal(history.base.value, 500);
    assertClose(shadowValue(history.base, history.flows, BARS.get("VOO")!, AS_OF), 644.4);
  });

  it("without benchmark closes there is no shadow", () => {
    assert.equal(shadowValue({ date: "2026-09-04", value: 1000 }, [], [], AS_OF), null);
  });
});

describe("moneyWeightedReturn", () => {
  it("modified Dietz: each flow is weighted by the part of the period it was invested", () => {
    // 6 days; +100 invested 3 of 6 and −100 out 1 of 6: average capital 1,033.33.
    const flows = [
      { date: "2026-09-07", amount: 100 },
      { date: "2026-09-09", amount: -100 },
    ];
    assertClose(
      moneyWeightedReturn({ date: "2026-09-04", value: 1000 }, { date: AS_OF, value: 975 }, flows),
      (-25 / (1000 + 100 / 2 - 100 / 6)) * 100,
    );
  });

  it("without days in the period or without capital, null", () => {
    assert.equal(moneyWeightedReturn({ date: AS_OF, value: 1000 }, { date: AS_OF, value: 1010 }, []), null);
    assert.equal(moneyWeightedReturn({ date: "2026-09-04", value: 0 }, { date: AS_OF, value: 0 }, []), null);
  });
});

describe("siloPerformance", () => {
  it("real against shadow, with returns and drawdown", () => {
    const { performance: eur, warnings } = siloPerformance(input());
    assertClose(eur.real, 975);
    assertClose(eur.shadow, 999);
    assert.ok(eur.realReturnPct! < eur.shadowReturnPct!);
    assert.deepEqual(warnings, []);
  });

  // Real case of 2026-09-15: Yahoo did not have VOO's Monday 09-14 session,
  // the silo started with Friday's closes and Monday's stock drop showed up
  // as a −4.1% on the first day.
  it("without flows or trades, real and shadow match even if the benchmark misses the previous session", () => {
    const bars = new Map([
      ["VOO", weekdayBars("2026-09-10", [800, 810])], // Thu 09-10 and Fri 09-11
      ["AAA", weekdayBars("2026-09-11", [100, 90])], // Fri 09-11 and Mon 09-14
    ]);
    const { performance: perf } = siloPerformance({
      currency: "USD",
      portfolio: snapshot("USD", 0, [{ ...AAA_POSITION, currency: "USD", volume: 1 }]),
      decisions: [],
      start: "2026-09-15",
      asOf: "2026-09-15",
      bars,
      reference: "VOO",
    });
    assertClose(perf.real, 90);
    assertClose(perf.shadow, 90);
    assert.equal(perf.drawdown.currentPct, 0);
  });

  it("without a benchmark warns and leaves the shadow empty", () => {
    const { performance: eur, warnings } = siloPerformance(input({ reference: "NO.EXISTE" }));
    assert.equal(eur.shadow, null);
    assert.deepEqual(warnings, [{ kind: "noShadow", currency: "EUR", reference: "NO.EXISTE" }]);
  });
});
