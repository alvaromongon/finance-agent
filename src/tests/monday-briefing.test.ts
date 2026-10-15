// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterSafeRetireList,
  buildTechnicalsSection,
  computeAssetClassWeights,
  formatPortfolioWeights,
  formatUsdCushion,
  validateBriefingReport,
  buildBriefingLogContent,
  webSearchSucceeded,
  injectMacroSearchWarning,
} from "../utils/monday-briefing-helpers.js";
import type { TechnicalsProvider } from "../utils/monday-briefing-helpers.js";
import type { HistoricalBar } from "../providers/types.js";
import type { PortfolioSnapshot, WatchlistEntry } from "../types.js";

// ── filterSafeRetireList ──────────────────────────────────────────────────────
// Deterministic guardrail: the model may propose removing a ticker that
// still has an open position (the system prompt forbids it, but trusting the
// prompt is not enough). It must never be removed.

describe("filterSafeRetireList", () => {
  it("lets through tickers without an open position", () => {
    const result = filterSafeRetireList(["AAA", "BBB"], new Set());
    assert.deepEqual(result.safe, ["AAA", "BBB"]);
    assert.deepEqual(result.blocked, []);
  });

  it("blocks tickers with an open position in either silo", () => {
    const result = filterSafeRetireList(["AAA", "BBB"], new Set(["BBB"]));
    assert.deepEqual(result.safe, ["AAA"]);
    assert.deepEqual(result.blocked, ["BBB"]);
  });

  it("an empty removal list yields neither safe nor blocked", () => {
    const result = filterSafeRetireList([], new Set(["AAA"]));
    assert.deepEqual(result.safe, []);
    assert.deepEqual(result.blocked, []);
  });

  it("all blocked if all have an open position", () => {
    const result = filterSafeRetireList(["AAA", "BBB"], new Set(["AAA", "BBB"]));
    assert.deepEqual(result.safe, []);
    assert.deepEqual(result.blocked, ["AAA", "BBB"]);
  });
});

// ── buildTechnicalsSection ────────────────────────────────────────────────────

function bars(closes: number[]): HistoricalBar[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    close,
    high: close * 1.01,
    low: close * 0.99,
  }));
}

function fakeProvider(overrides: Partial<TechnicalsProvider> = {}): TechnicalsProvider {
  return {
    getHistorical: async () => bars(Array.from({ length: 60 }, (_, i) => 100 + i)),
    getPrices: async (tickers) => new Map(tickers.map((t) => [t, 159])),
    ...overrides,
  };
}

describe("buildTechnicalsSection", () => {
  it("returns '(no assets)' when there are no tickers", async () => {
    const section = await buildTechnicalsSection(fakeProvider(), []);
    assert.equal(section, "(no assets)");
  });

  it("includes one block per ticker with the technical data", async () => {
    const section = await buildTechnicalsSection(fakeProvider(), ["XOM"]);
    assert.match(section, /### XOM/);
    assert.match(section, /Current price: 159\.00/);
    assert.match(section, /52w High\/Low:/);
    assert.match(section, /SMA 50d\/200d:/);
  });

  it("handles tickers without historical data without throwing", async () => {
    const provider = fakeProvider({ getHistorical: async () => [] });
    const section = await buildTechnicalsSection(provider, ["NODATA"]);
    assert.match(section, /### NODATA\n\(no technicals available\)/);
  });

  it("catches provider errors per ticker without aborting the rest", async () => {
    const provider = fakeProvider({
      getHistorical: async (ticker) => {
        if (ticker === "BROKEN") throw new Error("boom");
        return bars(Array.from({ length: 60 }, (_, i) => 100 + i));
      },
    });
    const section = await buildTechnicalsSection(provider, ["BROKEN", "XOM"]);
    assert.match(section, /### BROKEN\n\(error fetching technicals: boom\)/);
    assert.match(section, /### XOM/);
  });
});

// ── computeAssetClassWeights / formatPortfolioWeights ─────────────────

function emptyPortfolio(currency: "EUR" | "USD"): PortfolioSnapshot {
  return { currency, cash: 0, positions: [], syncedAt: "2026-07-10T00:00:00Z" };
}

function position(overrides: Partial<PortfolioSnapshot["positions"][number]> = {}) {
  return {
    ticker: "TICK",
    currency: "EUR" as const,
    volume: 1,
    avgPrice: 100,
    currentPrice: 100,
    pl: 0,
    stopLoss: null,
    ...overrides,
  };
}

function watchlistEntry(overrides: Partial<WatchlistEntry> = {}): WatchlistEntry {
  return {
    ticker: "TICK",
    name: "Test",
    market: "Test market",
    currency: "EUR",
    horizon: "medium",
    thesis: "test",
    ...overrides,
  };
}

describe("computeAssetClassWeights", () => {
  it("throws if eurUsdRate is not positive", () => {
    assert.throws(() => computeAssetClassWeights(emptyPortfolio("EUR"), emptyPortfolio("USD"), [], [], 0));
  });

  it("empty portfolio: total 0, no breakdown", () => {
    const w = computeAssetClassWeights(emptyPortfolio("EUR"), emptyPortfolio("USD"), [], [], 1.1);
    assert.equal(w.totalValueEur, 0);
    assert.deepEqual(w.byAssetClass, []);
    assert.deepEqual(w.byPosition, []);
  });

  it("a single EUR position is 100% of its class", () => {
    const eurPortfolio: PortfolioSnapshot = {
      ...emptyPortfolio("EUR"),
      positions: [position({ ticker: "DEF.MI", volume: 2, currentPrice: 50 })],
    };
    const eurWatchlist = [watchlistEntry({ ticker: "DEF.MI", asset_class: "equity" })];
    const w = computeAssetClassWeights(eurPortfolio, emptyPortfolio("USD"), eurWatchlist, [], 1.1);
    assert.equal(w.totalValueEur, 100);
    assert.equal(w.byAssetClass.length, 1);
    assert.equal(w.byAssetClass[0].assetClass, "equity");
    assert.equal(w.byAssetClass[0].pct, 100);
  });

  it("converts USD positions to EUR-equivalent by dividing by the exchange rate", () => {
    const usdPortfolio: PortfolioSnapshot = {
      ...emptyPortfolio("USD"),
      positions: [position({ ticker: "MSFT", currency: "USD", volume: 10, currentPrice: 110 })],
    };
    // 10 * 110 USD = 1100 USD; a 1.10 USD/EUR -> 1000 EUR
    const w = computeAssetClassWeights(emptyPortfolio("EUR"), usdPortfolio, [], [], 1.1);
    assert.ok(Math.abs(w.totalValueEur - 1000) < 1e-9);
  });

  it("combines EUR and USD (EUR-equivalent) positions in the same total", () => {
    const eurPortfolio: PortfolioSnapshot = {
      ...emptyPortfolio("EUR"),
      positions: [position({ ticker: "DEF.MI", volume: 1, currentPrice: 500 })],
    };
    const usdPortfolio: PortfolioSnapshot = {
      ...emptyPortfolio("USD"),
      positions: [position({ ticker: "MSFT", currency: "USD", volume: 1, currentPrice: 550 })],
    };
    // 500 EUR + (550 USD / 1.1) = 500 + 500 = 1000
    const w = computeAssetClassWeights(eurPortfolio, usdPortfolio, [], [], 1.1);
    assert.ok(Math.abs(w.totalValueEur - 1000) < 1e-9);
    assert.ok(Math.abs((w.byPosition.find((p) => p.ticker === "DEF.MI")?.pct ?? NaN) - 50) < 1e-9);
    assert.ok(Math.abs((w.byPosition.find((p) => p.ticker === "MSFT")?.pct ?? NaN) - 50) < 1e-9);
  });

  it("groups by asset_class and computes the % of each class", () => {
    const eurPortfolio: PortfolioSnapshot = {
      ...emptyPortfolio("EUR"),
      positions: [
        position({ ticker: "DEF.MI", volume: 1, currentPrice: 750 }),
        position({ ticker: "4GLD.DE", volume: 1, currentPrice: 250 }),
      ],
    };
    const eurWatchlist = [
      watchlistEntry({ ticker: "DEF.MI", asset_class: "equity" }),
      watchlistEntry({ ticker: "4GLD.DE", asset_class: "commodity" }),
    ];
    const w = computeAssetClassWeights(eurPortfolio, emptyPortfolio("USD"), eurWatchlist, [], 1.1);
    assert.equal(w.totalValueEur, 1000);
    const commodity = w.byAssetClass.find((c) => c.assetClass === "commodity");
    assert.equal(commodity?.pct, 25);
    const equity = w.byAssetClass.find((c) => c.assetClass === "equity");
    assert.equal(equity?.pct, 75);
  });

  it("a ticker without a watchlist entry falls back to asset_class equity", () => {
    const eurPortfolio: PortfolioSnapshot = {
      ...emptyPortfolio("EUR"),
      positions: [position({ ticker: "HUERFANO", volume: 1, currentPrice: 100 })],
    };
    const w = computeAssetClassWeights(eurPortfolio, emptyPortfolio("USD"), [], [], 1.1);
    assert.equal(w.byPosition[0].assetClass, "equity");
  });
});

describe("formatPortfolioWeights", () => {
  it("says explicitly when there are no positions", () => {
    const w = computeAssetClassWeights(emptyPortfolio("EUR"), emptyPortfolio("USD"), [], [], 1.1);
    assert.match(formatPortfolioWeights(w), /no open positions/);
  });

  it("includes the ticker and the % in the formatted text", () => {
    const eurPortfolio: PortfolioSnapshot = {
      ...emptyPortfolio("EUR"),
      positions: [position({ ticker: "DEF.MI", volume: 1, currentPrice: 100 })],
    };
    const w = computeAssetClassWeights(eurPortfolio, emptyPortfolio("USD"), [], [], 1.1);
    const text = formatPortfolioWeights(w);
    assert.match(text, /DEF\.MI/);
    assert.match(text, /100\.0%/);
  });
});

// ── computeAssetClassWeights: warning for an orphan ticker ────────────────────────
// A position without a watchlist entry silently falls back to "equity", which
// can skew the commodities % of the portfolio policy — it must be warned about
// on the console (not thrown: the breakdown is still roughly useful).

describe("computeAssetClassWeights — orphan ticker warning", () => {
  it("warns on the console when a position is not in the watchlist", () => {
    const original = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const eurPortfolio: PortfolioSnapshot = {
        ...emptyPortfolio("EUR"),
        positions: [position({ ticker: "HUERFANO", volume: 1, currentPrice: 100 })],
      };
      computeAssetClassWeights(eurPortfolio, emptyPortfolio("USD"), [], [], 1.1);
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0][0]), /HUERFANO/);
    } finally {
      console.warn = original;
    }
  });

  it("does not warn when all positions are in the watchlist", () => {
    const original = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const eurPortfolio: PortfolioSnapshot = {
        ...emptyPortfolio("EUR"),
        positions: [position({ ticker: "DEF.MI", volume: 1, currentPrice: 100 })],
      };
      const eurWatchlist = [watchlistEntry({ ticker: "DEF.MI", asset_class: "equity" })];
      computeAssetClassWeights(eurPortfolio, emptyPortfolio("USD"), eurWatchlist, [], 1.1);
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = original;
    }
  });
});

// ── formatUsdCushion (ADR-0009 §6) ─────────────────────────────────
// The briefing's only FX decision: convert only what is missing for the USD
// silo's free cash to cover a position of the cap size.

describe("formatUsdCushion", () => {
  it("covered: free cash reaches the per-position cap", () => {
    assert.match(
      formatUsdCushion({ cash: 700, value: 2400 }, 1.17, 25),
      /USD cushion: covered — free cash 700\.00 \$ ≥ per-position cap 600\.00 \$/,
    );
  });

  it("if short, gives the amount in $ and in € at today's rate, and when to convert", () => {
    const line = formatUsdCushion({ cash: 250, value: 2400 }, 1.25, 25);
    assert.match(line, /350\.00 \$ \(≈ 280\.00 € at 1\.2500\) missing/);
    assert.match(line, /business day/);
  });

  it("without an exchange rate gives only the amount in $", () => {
    assert.doesNotMatch(formatUsdCushion({ cash: 250, value: 2400 }, null, 25), /€/);
  });
});

// ── validateBriefingReport / buildBriefingLogContent ────────────────
// In handoff mode the report arrives on stdin from the Routine: the equivalent
// of the API mode max_tokens check is validating the structure before
// writing anything to the vault.

const VALID_REPORT = `## 0. Resumen ejecutivo

- Acumular cash esta semana; sin salidas.

## 1. Plan de la semana

Acumular cash. Para el cash en EUR: acumular en EUR.

## 2. Salud de posiciones

| Ticker | P/L actual | Stop actual | Veredicto | Notas |
|---|---|---|---|---|
| MSFT | +5% | 90 | MANTENER | — |

## 3. Watchlist — Revisión de umbrales

| Ticker | Precio ref. | Buy range actual | Veredicto | Ajuste sugerido |
|---|---|---|---|---|
| XOM | 100 | 90-95 | RETIRE | — |

## 4. Contexto macro y sectorial

- Sin novedades relevantes (conocimiento entrenado, la búsqueda no aportó nada nuevo).

## 5. Próximos eventos a vigilar

| Fecha | Activo | Evento | Impacto esperado |
|---|---|---|---|
| 2026-08-01 | MSFT | Earnings | Alto |

## AUTOMATED_ACTIONS
RETIRE: XOM
PLAN_SUMMARY: Acumular cash esta semana
PROPOSALS: []
`;

describe("validateBriefingReport", () => {
  it("accepts a complete report with every section", () => {
    assert.deepEqual(validateBriefingReport(VALID_REPORT), []);
  });

  it("rejects an empty or whitespace-only report", () => {
    assert.deepEqual(validateBriefingReport(""), ["the report is empty"]);
    assert.deepEqual(validateBriefingReport("  \n\n "), ["the report is empty"]);
  });

  it("detects a truncated report (cut before AUTOMATED_ACTIONS)", () => {
    const truncated = VALID_REPORT.slice(0, VALID_REPORT.indexOf("## 5."));
    const problems = validateBriefingReport(truncated);
    assert.ok(
      problems.some((p) => p.includes("Próximos eventos")),
      `expected a section 5 warning: ${problems.join(", ")}`,
    );
    assert.ok(
      problems.some((p) => p.includes("AUTOMATED_ACTIONS")),
      `expected an AUTOMATED_ACTIONS warning: ${problems.join(", ")}`,
    );
  });

  it("collects every problem in a single pass", () => {
    const problems = validateBriefingReport("## Algo irrelevante\n\ntexto");
    // 6 secciones obligatorias + AUTOMATED_ACTIONS
    assert.equal(problems.length, 7);
  });

  it("requires the RETIRE: line right under the AUTOMATED_ACTIONS heading", () => {
    const report = VALID_REPORT.replace("RETIRE: XOM\n", "");
    const problems = validateBriefingReport(report);
    assert.ok(problems.some((p) => p.includes("AUTOMATED_ACTIONS")));
  });

  it("rejects an empty PLAN_SUMMARY", () => {
    const report = VALID_REPORT.replace(/^PLAN_SUMMARY:.*$/m, "PLAN_SUMMARY:");
    const problems = validateBriefingReport(report);
    assert.ok(problems.some((p) => p.includes("PLAN_SUMMARY")));
  });

  // Proposals are recorded, so the line is required.
  it("requires the PROPOSALS: line and valid JSON in it", () => {
    const withoutLine = validateBriefingReport(VALID_REPORT.replace(/^PROPOSALS:.*\n?/m, ""));
    assert.ok(
      withoutLine.some((p) => p.includes("missing PROPOSALS: line")),
      withoutLine.join(", "),
    );

    const broken = validateBriefingReport(VALID_REPORT.replace("PROPOSALS: []", "PROPOSALS: [{ticker: XOM}]"));
    assert.ok(
      broken.some((p) => p.includes("PROPOSALS is not valid single-line JSON")),
      broken.join(", "),
    );

    const empty = validateBriefingReport(VALID_REPORT.replace("PROPOSALS: []", "PROPOSALS:"));
    assert.deepEqual(empty, []);
  });

  it("RETIRE: without tickers is valid (week without removals)", () => {
    const report = VALID_REPORT.replace(/^RETIRE:.*$/m, "RETIRE:");
    assert.deepEqual(validateBriefingReport(report), []);
  });

  it("tolerates different heading levels and number prefixes", () => {
    const report = VALID_REPORT.replace("## 0. Resumen ejecutivo", "# Resumen ejecutivo").replace(
      "## 1. Plan de la semana",
      "### Plan de la semana",
    );
    assert.deepEqual(validateBriefingReport(report), []);
  });

  it("rejects section 4 if it cites no sources and does not admit the search failed", () => {
    const report = VALID_REPORT.replace(
      "- Sin novedades relevantes (conocimiento entrenado, la búsqueda no aportó nada nuevo).",
      "- Todo tranquilo en el sector esta semana.",
    );
    const problems = validateBriefingReport(report);
    assert.ok(
      problems.some((p) => p.includes("Contexto macro")),
      `expected a section 4 warning without citation/disclaimer: ${problems.join(", ")}`,
    );
  });

  it("accepts section 4 if it cites a real source (link or URL)", () => {
    const report = VALID_REPORT.replace(
      "- Sin novedades relevantes (conocimiento entrenado, la búsqueda no aportó nada nuevo).",
      "- Tipos al alza según [Reuters](https://reuters.com/algo).",
    );
    assert.deepEqual(validateBriefingReport(report), []);
  });

  it("accepts section 4 if it cites 'Fuente:' even without a Markdown link", () => {
    const report = VALID_REPORT.replace(
      "- Sin novedades relevantes (conocimiento entrenado, la búsqueda no aportó nada nuevo).",
      "- Tipos al alza esta semana. Fuente: Bloomberg.",
    );
    assert.deepEqual(validateBriefingReport(report), []);
  });
});

// ── webSearchSucceeded / injectMacroSearchWarning (section 4 safety net) ──
// In API mode we do see the `web_search` tool_results: we do not rely on the
// model declaring the failure, we detect it and guarantee it ourselves.

describe("webSearchSucceeded", () => {
  it("false if there is no web_search_tool_result block", () => {
    assert.equal(webSearchSucceeded([{ type: "text" }]), false);
  });

  it("false if every web_search_tool_result is an error (content is not an array)", () => {
    assert.equal(
      webSearchSucceeded([
        {
          type: "web_search_tool_result",
          content: { type: "web_search_tool_result_error", error_code: "unavailable" },
        },
      ]),
      false,
    );
  });

  it("true if at least one web_search_tool_result has results (content is an array)", () => {
    assert.equal(
      webSearchSucceeded([
        {
          type: "web_search_tool_result",
          content: { type: "web_search_tool_result_error", error_code: "too_many_requests" },
        },
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://x.com" }] },
      ]),
      true,
    );
  });
});

describe("injectMacroSearchWarning", () => {
  it("leaves the report alone if the search succeeded", () => {
    assert.equal(injectMacroSearchWarning(VALID_REPORT, true), VALID_REPORT);
  });

  it("inserts the notice right below the section 4 heading if the search failed", () => {
    const result = injectMacroSearchWarning(VALID_REPORT, false);
    assert.ok(result.includes("Aviso automático"));
    const macroIdx = result.indexOf("## 4. Contexto macro y sectorial");
    const warningIdx = result.indexOf("Aviso automático");
    const originalBulletIdx = result.indexOf("Sin novedades relevantes");
    assert.ok(
      macroIdx < warningIdx && warningIdx < originalBulletIdx,
      "the notice must go between the heading and the original content",
    );
  });

  it("the injected notice makes validateBriefingReport stop complaining about a missing citation/disclaimer", () => {
    const bare = VALID_REPORT.replace(
      "- Sin novedades relevantes (conocimiento entrenado, la búsqueda no aportó nada nuevo).",
      "- Todo tranquilo en el sector esta semana.",
    );
    const withWarning = injectMacroSearchWarning(bare, false);
    assert.deepEqual(validateBriefingReport(withWarning), []);
  });

  it("no-op if section 4 does not exist (the heading check already covers it)", () => {
    const noSection4 = "## Algo irrelevante\n\ntexto";
    assert.equal(injectMacroSearchWarning(noSection4, false), noSection4);
  });
});

describe("buildBriefingLogContent", () => {
  it("includes frontmatter with id and the report as body", () => {
    const content = buildBriefingLogContent("2026-07-20", VALID_REPORT);
    assert.match(content, /^---\n/);
    assert.match(content, /id: 20260720-monday-briefing/);
    assert.match(content, /title: "Monday Briefing — 2026-07-20"/);
    assert.match(content, /created: 2026-07-20/);
    assert.ok(content.endsWith(VALID_REPORT), "the report goes after the frontmatter");
  });
});
