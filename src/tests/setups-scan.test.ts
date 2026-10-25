import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectNewSetups } from "../utils/setups/index.js";
import { scanSetups } from "../utils/setups/scan.js";
import { extend, uptrend } from "./fixtures/setup-bars.js";
import { buildDecision } from "../decisions.js";
import type { HistoricalBar } from "../providers/types.js";
import type { PortfolioSnapshot, WatchlistEntry } from "../types.js";
import { parseTicker as tk } from "../ticker.js";

const entry = (ticker: string): WatchlistEntry => ({
  ticker: tk(ticker),
  name: ticker,
  market: "NYSE",
  currency: "USD",
  horizon: "medium",
  thesis: "t",
});

// Pullback confirmed on the last session (see setups.test.ts).
const up = uptrend(220);
const top = up[up.length - 1].close;
const pullback = extend(up, [top - 1.5, top - 3, top - 4.5, [top - 5, { low: top - 6 }], top - 2]);

// A fifteen-session base right at the high: armed today for the first time.
const run = uptrend(150);
const high = run[run.length - 1].close;
const base = extend(
  run,
  Array.from({ length: 15 }, (_, i) => high + (i % 2 ? 0.5 : -0.5)),
);
const firstArmed = Array.from({ length: 16 }, (_, i) => base.slice(0, run.length + i)).find((bars) =>
  detectNewSetups(bars).some((s) => s.state === "armed"),
)!;

const history: Record<string, HistoricalBar[]> = { PB: pullback, BO: firstArmed, HELD: pullback, FLAT: uptrend(250) };
const provider = { getHistorical: async (ticker: string) => history[ticker] ?? [] };

const portfolio = (positions: PortfolioSnapshot["positions"] = []): PortfolioSnapshot => ({
  currency: "USD",
  cash: 1000,
  positions,
  lots: [],
  syncedAt: "2026-09-24T00:00:00Z",
});
const held = {
  ticker: tk("HELD"),
  currency: "USD" as const,
  volume: 1,
  avgPrice: 200,
  currentPrice: 200,
  pl: 0,
  stopLoss: 180,
};

const scan = (over: Partial<Parameters<typeof scanSetups>[0]> = {}) =>
  scanSetups({
    watchlist: ["PB", "BO", "HELD", "FLAT"].map(entry),
    portfolio: portfolio([held]),
    provider,
    date: "2026-09-24",
    rulesVersion: "0.7",
    benchmark: { ticker: tk("VOO"), price: 800, regime: "favorable" },
    log: () => {},
    ...over,
  });

describe("scanSetups (ADR-0013)", () => {
  it("a buyable pullback comes out as a `setup` signal with its target as the only level", async () => {
    const { signals } = await scan();
    assert.deepEqual(
      signals.map((s) => s.ticker),
      ["PB"],
    );
    const [s] = signals;
    assert.deepEqual(s.triggers, ["setup"]);
    assert.equal(s.setup?.pattern, "pullback");
    assert.equal(s.price, s.setup?.level);
    assert.deepEqual(s.strength?.levels, [s.setup.target]);
    assert.equal(s.siloValue, 1200);
    assert.equal(s.benchmark?.regime, "favorable");
  });

  it("does not look for setups in what already has a position", async () => {
    const { signals, decisions } = await scan();
    assert.ok(![...signals, ...decisions].some((d) => d.ticker === "HELD"));
  });

  it("an armed breakout is recorded as setup_armed with the Buy Stop level, and goes to the alert", async () => {
    const { decisions, notices } = await scan();
    const armed = decisions.find((d) => d.ticker === "BO")!;
    assert.equal(armed.type, "setup_armed");
    assert.equal(armed.source, "heartbeat");
    assert.equal(armed.setup?.state, "armed");
    assert.ok(armed.target! > armed.setup.level);
    assert.ok(armed.stop_initial! < armed.setup.level);
    assert.equal(armed.regime, "favorable");
    assert.ok(armed.eligibility);
    assert.ok(notices.some((n) => n.ticker === "BO" && n.setup.state === "armed"));
  });

  it("in an adverse regime the pullback does not escalate: it stays buy_blocked with its setup", async () => {
    const { signals, decisions } = await scan({ benchmark: { ticker: tk("VOO"), price: 800, regime: "adverso" } });
    assert.deepEqual(signals, []);
    const pb = decisions.find((d) => d.ticker === "PB")!;
    assert.equal(pb.type, "buy_blocked");
    assert.deepEqual(pb.eligibility, { verdict: "blocked", reasons: ["regime_adverse"] });
    assert.deepEqual(pb.setup, { pattern: "pullback", state: "triggered", level: pullback[pullback.length - 1].close });
    assert.ok(pb.target != null && pb.stop_initial != null);
  });

  it("the signal carries the engine conviction: screening quintile and catalyst, the day's regime and R:R", async () => {
    const screened = buildDecision({
      date: "2026-09-19",
      ticker: tk("PB"),
      currency: "USD",
      origin: "sistema",
      source: "screening",
      type: "screen_interesting",
      price: 100,
      conviction: "high",
      conviction_points: ["top_quintile", "regime_favorable", "dated_catalyst"],
      rules_version: "1.1",
    });
    const [s] = (await scan({ history: [screened] })).signals;
    assert.equal(s.conviction?.conviction, "high");
    assert.deepEqual(
      s.conviction?.points.filter((p) => p !== "reward_risk"),
      ["top_quintile", "regime_favorable", "dated_catalyst"],
    );

    const [alone] = (await scan()).signals;
    assert.ok(alone.conviction?.points.includes("regime_favorable"));
    assert.ok(!alone.conviction?.points.includes("top_quintile"), "without a screening there is no quintile");
  });

  it("blocked ones and armed breakouts carry a conviction too, to measure them", async () => {
    const { decisions } = await scan({ benchmark: { ticker: tk("VOO"), price: 800, regime: "adverso" } });
    for (const d of decisions) {
      assert.ok(d.conviction, `${d.ticker} without conviction`);
      assert.ok(d.conviction_points && !d.conviction_points.includes("regime_favorable"));
    }
  });

  it("without history there are no setups and the run goes on", async () => {
    const logs: string[] = [];
    const failing = {
      getHistorical: async () => {
        throw new Error("Yahoo caído");
      },
    };
    const result = await scan({ provider: failing, log: (m) => logs.push(m) });
    assert.deepEqual(result, { signals: [], decisions: [], notices: [] });
    assert.ok(logs.some((l) => l.includes("Yahoo caído")));
  });
});
