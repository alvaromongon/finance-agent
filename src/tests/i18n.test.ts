// Localized output: OUTPUT_LANGUAGE picks the catalog, English by
// default. The Spanish output is asserted by each module's own tests; these
// cover the English renders and the language switch (the English alert is in mailer.test.ts).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { en } from "../i18n/en.js";
import { es } from "../i18n/es.js";
import { formatNumber, messages } from "../i18n/index.js";
import { renderHeartbeatDigest, type HeartbeatDigest } from "../utils/heartbeat-digest.js";
import { detectStopBreaches } from "../utils/stop-breach.js";
import { detectTightStops } from "../utils/atr-stop.js";
import { describeTicket } from "../utils/sizing.js";
import { describeConviction } from "../utils/conviction.js";
import { formatRegimeLines } from "../utils/market-regime.js";
import { formatEngineTicketsSection } from "../utils/briefing-decisions.js";
import { buildThesisNote, describeExitDetail, describeRankingFallback } from "../utils/screening-helpers.js";
import { twoMonthRuleWarning, type Decision } from "../decisions.js";
import { describeSetup, detectNewSetups } from "../utils/setups/index.js";
import { scanSetups } from "../utils/setups/scan.js";
import { extend, uptrend } from "./fixtures/setup-bars.js";
import { SPANISH } from "./fixtures/spanish.js";
import type { BuyTicket, Position } from "../types.js";
import { parseTicker as tk } from "../ticker.js";

function position(overrides: Partial<Position> = {}): Position {
  return {
    ticker: tk("MSFT"),
    currency: "USD",
    volume: 1,
    avgPrice: 492.01,
    currentPrice: 501.02,
    pl: 9.01,
    stopLoss: 500,
    ...overrides,
  };
}

const BUY_TICKET: BuyTicket = {
  kind: "BUY",
  currency: "USD",
  entry: 124.5,
  stop: 118,
  stopAtr: 3,
  units: 0.3614,
  amount: 45,
  costs: 0.18,
  taxPct: 0.4,
  risk: 2.35,
  riskBudget: 2.4,
  cappedBy: "cash",
  target: 140,
  rrGross: 2.38,
  rrNet: 2.3,
};

// A base of fifteen sessions at the high: armed for the first time (see setups-scan.test.ts).
const run = uptrend(150);
const high = run[run.length - 1].close;
const base = extend(
  run,
  Array.from({ length: 15 }, (_, i) => high + (i % 2 ? 0.5 : -0.5)),
);
const firstArmed = Array.from({ length: 16 }, (_, i) => base.slice(0, run.length + i)).find((bars) =>
  detectNewSetups(bars).some((s) => s.state === "armed"),
)!;
const { notices: armed } = await scanSetups({
  watchlist: [{ ticker: tk("BO"), name: "BO", market: "NYSE", currency: "USD", horizon: "medium", thesis: "t" }],
  portfolio: { currency: "USD", cash: 1000, positions: [], lots: [], syncedAt: "2026-09-24T00:00:00Z" },
  provider: { getHistorical: async () => firstArmed },
  date: "2026-09-24",
  rulesVersion: "0.7",
  benchmark: { ticker: tk("VOO"), price: 800, regime: "favorable" },
  log: () => {},
});

describe("OUTPUT_LANGUAGE", () => {
  afterEach(() => {
    delete process.env.OUTPUT_LANGUAGE;
  });

  it("defaults to English", () => {
    delete process.env.OUTPUT_LANGUAGE;
    assert.equal(config.output.language(), "en");
    assert.equal(messages(), en);
  });

  it("selects the Spanish catalog with es", () => {
    process.env.OUTPUT_LANGUAGE = "es";
    assert.equal(messages(), es);
  });

  it("tolerates case and surrounding spaces", () => {
    process.env.OUTPUT_LANGUAGE = " ES ";
    assert.equal(messages(), es);
  });

  it("rejects an unknown language instead of falling back silently", () => {
    process.env.OUTPUT_LANGUAGE = "fr";
    assert.throws(() => messages(), /OUTPUT_LANGUAGE="fr"/);
  });
});

describe("catalogs", () => {
  /** Dotted paths of every key, so a missing one shows up by name. */
  function keys(value: unknown, prefix = ""): string[] {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
    return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
  }

  it("es has exactly the keys of en", () => {
    assert.deepEqual(keys(es).sort(), keys(en).sort());
  });

  it("formats numbers in each catalog's locale", () => {
    assert.equal(formatNumber(en, 1234.5), "1,234.50");
    assert.equal(formatNumber(es, 1234.5), "1.234,50");
  });
});

describe("English renders", () => {
  it("the engine ticket", () => {
    assert.deepEqual(describeTicket(BUY_TICKET, en), [
      ["Units", "0.3614"],
      ["Amount", "45.00 USD"],
      ["Reference price", "124.5 USD"],
      ["Stop-loss", "118 USD (3 ATR)"],
      ["Target", "140 USD"],
      ["Risk", "2.35 USD of 2.40 (capped by available cash)"],
      ["R:R", "2.38 gross · 2.30 net"],
      ["Estimated costs", "0.18 USD (transaction tax 0.4%)"],
    ]);
    assert.deepEqual(
      describeTicket(
        { kind: "ADJUST_STOP", currency: "USD", price: 138, stop: 132, previousStop: null, stopAtr: 3 },
        en,
      ),
      [
        ["New stop-loss", "132 USD (3 ATR below the price)"],
        ["Previous stop", "no stop"],
        ["Reference price", "138 USD"],
      ],
    );
  });

  it("sell and untaxed buy tickets", () => {
    assert.deepEqual(describeTicket({ kind: "SELL", currency: "EUR", amount: 50, units: 1.5, price: 33 }, en), [
      ["Amount", "50.00 EUR"],
      ["Approx. units", "1.5"],
      ["Reference price", "33 EUR"],
    ]);
    const untaxed = describeTicket({ ...BUY_TICKET, taxPct: 0, costs: 0, cappedBy: "position" }, en);
    assert.deepEqual(untaxed.at(-1), ["Estimated costs", "0.00 USD (no transaction tax)"]);
    assert.match(untaxed[5][1], /capped by the per-position limit/);
  });

  it("setups: armed, confirmed and blocked", () => {
    assert.equal(armed.length, 1);
    const [notice] = armed;
    assert.match(
      describeSetup(notice, en),
      /^BO: breakout ARMED — Buy Stop at [\d.]+ USD, target [\d.]+ · stop [\d.]+, [\d.]+ units ≈ [\d.]+ USD, net R:R [\d.]+ · SMA50 dist\. [\d.]+ ATR — ELIGIBLE$/,
    );
    const confirmed = {
      ...notice,
      setup: { ...notice.setup, pattern: "pullback" as const, state: "triggered" as const },
      reasons: ["regime_adverse"],
    };
    assert.match(describeSetup(confirmed, en), /^BO: trend pullback confirmed at .* — BLOCKED \(regime_adverse\)$/);
  });

  it("conviction and market regime", () => {
    assert.equal(
      describeConviction({ conviction: "high", points: ["top_quintile", "regime_favorable", "dated_catalyst"] }, en),
      "high (top quintile, favorable regime, dated catalyst)",
    );
    assert.deepEqual(formatRegimeLines({ EUR: { ticker: tk("EXSA.DE"), price: 1, regime: "adverso" } }, en), [
      "Regime EUR (EXSA.DE): ADVERSE (benchmark below its SMA200): every new entry is BLOCKED",
      "Regime USD: no data, does not block",
    ]);
  });

  it("the heartbeat digest, with en-US numbers and no Spanish", () => {
    const digest: HeartbeatDigest = {
      currency: "USD",
      syncedAt: "2026-09-02T14:10:00Z",
      minAtr: 2,
      lotsWarnings: [],
      tickerWarnings: [],
      breaches: detectStopBreaches(
        [position({ ticker: tk("CAT"), avgPrice: 218, stopLoss: 213 })],
        new Map([["CAT", 210.77]]),
      ),
      tightStops: detectTightStops(
        [position({ avgPrice: 1490, stopLoss: 1495, currentPrice: 1501 })],
        new Map([["MSFT", 1501.02]]),
        new Map([["MSFT", 9.67]]),
      ),
      armed,
      escalated: [
        { ticker: tk("XOM"), currency: "USD", triggers: ["big_move"], price: 112.4, cash: 0, siloValue: 0 },
        {
          ticker: tk("CVX"),
          currency: "USD",
          triggers: ["setup"],
          price: 150,
          cash: 0,
          siloValue: 0,
          setup: { pattern: "pullback", state: "triggered", date: "2026-09-24", level: 150, target: 170 },
        },
      ],
    };

    const email = renderHeartbeatDigest(digest, en)!;

    assert.equal(
      email.subject,
      "[Finance Agent] Heartbeat USD — stop crossed: CAT · tight stop: MSFT · armed breakout: BO · to analysis: XOM, CVX",
    );
    assert.match(email.body, /## Stops crossed — check your broker/);
    assert.match(email.body, /\| CAT \| 210\.77 USD \| 213\.00 \|/);
    assert.match(email.body, /\| MSFT \| 1,501\.02 USD \| 1,495\.00 \|/);
    assert.match(email.body, /⚠️ In MSFT the reference stop sits \*\*below/);
    assert.match(email.body, /## Armed breakouts[\s\S]*- BO: breakout ARMED/);
    assert.match(email.body, /- XOM: big_move at 112\.40 USD\n/);
    assert.match(email.body, /- CVX: .* at 150\.00 USD \(pullback, pattern target 170\)/);
    assert.doesNotMatch(`${email.subject}\n${email.body}`, SPANISH);
  });
});

describe("English heartbeat digest, lots section", () => {
  it("mirrors the owner-approved wording (#69)", () => {
    const email = renderHeartbeatDigest(
      {
        currency: "USD",
        syncedAt: "2026-09-02T14:10:00Z",
        minAtr: 2,
        lotsWarnings: ["portfolio.md (USD): Lots row 1 skipped"],
        tickerWarnings: [],
        breaches: [],
        tightStops: [],
        armed: [],
        escalated: [],
      },
      en,
    )!;

    assert.match(email.subject, /problem with the lots/);
    assert.match(email.body, /## `portfolio\.md`: problem with the lots/);
    const text = email.body.replace(/\s+/g, " ");
    assert.match(
      text,
      /The `Lots` table cannot be read, is missing, or does not match `Positions` or the decision log\. The heartbeat keeps/,
    );
    assert.match(
      text,
      /Fix `Lots` by hand: it must exist and be readable, each `Volume` must be the sum of the `Units` of its lots and every `Entry id` must be an entry of the log/,
    );
    assert.doesNotMatch(`${email.subject}\n${email.body}`, SPANISH);
  });
});

describe("English briefing pieces", () => {
  it("engine tickets section", () => {
    const section = formatEngineTicketsSection(
      [
        {
          ticker: tk("MSFT"),
          action: "SELL",
          codes: [],
          ticket: { kind: "SELL", currency: "USD", amount: 50, units: 0.1, price: 500 },
        },
        { ticker: tk("XOM"), action: "ADJUST_STOP", codes: ["stop_not_raised"], ticket: null },
      ],
      en,
    );
    assert.match(section, /^## Engine tickets\n/);
    assert.match(section, /### SELL MSFT — PROPOSED\n\n\| Field \| Value \|/);
    assert.match(
      section,
      /### ADJUST_STOP XOM — BLOCKED \(stop_not_raised\)\n\nNo ticket: the engine could not compute it\./,
    );
    assert.doesNotMatch(section, SPANISH);
  });
});

describe("English notes and screening pieces", () => {
  it("thesis note: localized headings, technicals as the reasoner saw them", () => {
    const note = buildThesisNote(
      {
        ticker: tk("NVDA"),
        name: "NVIDIA",
        slug: "nvda",
        today: "2026-10-10",
        technicalsText: "Current price: 180.00",
        result: { thesis: "AI capex leader.", nextCatalyst: "Earnings 19 Nov", invalidation: [] },
      },
      en,
    );
    assert.match(note, /^title: "Thesis NVDA — NVIDIA"$/m);
    assert.match(note, /^exit_criteria: pending$/m);
    assert.match(note, /## Investment thesis\n\nAI capex leader\.\n\n## Technical analysis \(screening 2026-10-10\)/);
    assert.match(note, /## When it would stop being valid\n\n\(to be defined: fill it in/);
    assert.doesNotMatch(note, SPANISH);
  });

  it("two-month rule warning", () => {
    const loss = { type: "exit", ticker: "ADBE", date: "2026-08-31", pnl: -30, currency: "USD" } as Decision;
    assert.equal(
      twoMonthRuleWarning([loss], tk("ADBE"), "2026-09-15", "real", en),
      "Two-month rule (art. 33.5.f LIRPF): ADBE was sold at a loss (-30 USD) on 2026-08-31. Buying it back before 2026-10-31 defers that loss.",
    );
  });

  it("exit archive reason and ranking fallbacks, in both languages", () => {
    const exit = { ticker: tk("R1"), reason: "no_setup" as const, weeks: 4 };
    assert.equal(
      en.screening.exitArchiveReason("2026-10-10", describeExitDetail(exit, en)),
      "Mechanical exit 2026-10-10: no setup in the last 4 weeks",
    );
    assert.equal(
      es.screening.exitArchiveReason("2026-10-10", describeExitDetail(exit, es)),
      "Salida mecánica 2026-10-10: sin setup en las últimas 4 semanas",
    );

    assert.deepEqual(
      [
        { code: "no_reference_history" as const, ticker: tk("VOO") },
        { code: "low_coverage" as const, withData: 2, total: 4 },
        { code: "stale_universe" as const, medianLastBar: "2026-09-26" },
        { code: "stale_universe" as const },
      ].map((f) => [describeRankingFallback(f, en), describeRankingFallback(f, es)]),
      [
        ["no recent history for the benchmark VOO", "sin histórico reciente de la referencia VOO"],
        ["only 2 of 4 assets with data", "solo 2 de 4 valores con datos"],
        ["the universe's median last session is 2026-09-26", "la última sesión mediana del universo es 2026-09-26"],
        ["the universe's median last session is none", "la última sesión mediana del universo es ninguna"],
      ],
    );
  });
});
