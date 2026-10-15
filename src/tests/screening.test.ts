import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseScreeningLog,
  extractRetireList,
  extractPlanSummary,
  applyAddWatchlistEntry,
  applyRetireWatchlistEntry,
} from "../utils/vault-parser.js";
import type { WatchlistEntry } from "../types.js";

// ── parseScreeningLog ─────────────────────────────────────────────────────────

const SCREENING_LOG_MD = `---
schema_version: 1
title: Screening Log
---

## Historial

| Ticker | Name | Index | Date | Result | Summary | Next review |
|---|---|---|---|---|---|---|
| AAPL | Apple | S&P 500 | 2026-06-28 | not_interesting | High P/E | 2026-08-28 |
| ASML.AS | ASML | Eurostoxx 50 | 2026-06-28 | interesting | Semicond IA | — |
| MSFT | Microsoft | S&P 500 | 2026-06-21 | not_interesting | Sin catalizador | 2026-08-21 |
`;

describe("parseScreeningLog", () => {
  it("parses the data rows correctly", () => {
    const rows = parseScreeningLog(SCREENING_LOG_MD);
    assert.equal(rows.length, 3);
  });

  it("rejects a screening-log without schema_version", () => {
    assert.throws(
      () => parseScreeningLog(SCREENING_LOG_MD.replace("schema_version: 1\n", "")),
      /screening-log\.md.*schema_version/,
    );
  });

  it("rejects an unknown Result, naming the row", () => {
    const md = SCREENING_LOG_MD.replace(
      "| 2026-06-28 | not_interesting | High P/E |",
      "| 2026-06-28 | No interesante | High P/E |",
    );
    assert.throws(
      () => parseScreeningLog(md),
      /screening-log\.md: unknown Result "No interesante" in row AAPL of 2026-06-28/,
    );
  });

  it("does not include the header row", () => {
    const rows = parseScreeningLog(SCREENING_LOG_MD);
    assert.ok(rows.every((r) => r.ticker !== "Ticker"));
  });

  it("maps the fields correctly", () => {
    const rows = parseScreeningLog(SCREENING_LOG_MD);
    const aapl = rows[0];
    assert.equal(aapl.ticker, "AAPL");
    assert.equal(aapl.name, "Apple");
    assert.equal(aapl.index, "S&P 500");
    assert.equal(aapl.date, "2026-06-28");
    assert.equal(aapl.result, "not_interesting");
    assert.equal(aapl.summary, "High P/E");
    assert.equal(aapl.nextReview, "2026-08-28");
  });

  it("parses the 'interesting' result correctly", () => {
    const rows = parseScreeningLog(SCREENING_LOG_MD);
    const asml = rows[1];
    assert.equal(asml.result, "interesting");
    assert.equal(asml.nextReview, "—");
  });

  it("returns an empty array for markdown without a table", () => {
    const rows = parseScreeningLog("---\nschema_version: 1\n---\n# Sin tabla\n\nTexto normal.");
    assert.equal(rows.length, 0);
  });

  it("rejects an empty string: it lacks schema_version", () => {
    assert.throws(() => parseScreeningLog(""), /schema_version/);
  });
});

// ── extractRetireList ─────────────────────────────────────────────────────────

describe("extractRetireList", () => {
  it("extracts tickers from the AUTOMATED_ACTIONS section", () => {
    const text = `## Resumen\n\nAlgún texto.\n\n## AUTOMATED_ACTIONS\nRETIRE: IBE.MC,SAN.MC`;
    const result = extractRetireList(text);
    assert.deepEqual(result, ["IBE.MC", "SAN.MC"]);
  });

  it("returns an empty array if RETIRE is empty", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE:`;
    assert.deepEqual(extractRetireList(text), []);
  });

  it("an empty RETIRE: does not swallow the next line (regression)", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE:\nPLAN_SUMMARY: Acumular cash, sin compras\nPROPOSALS: []`;
    assert.deepEqual(extractRetireList(text), []);
  });

  it("returns an empty array if there is no AUTOMATED_ACTIONS section", () => {
    assert.deepEqual(extractRetireList("## Resumen\n\nSin acciones."), []);
  });

  it("trims spaces around each ticker", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE:  XOM , VST `;
    const result = extractRetireList(text);
    assert.deepEqual(result, ["XOM", "VST"]);
  });

  it("returns a single ticker without a comma", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE: IBE.MC`;
    assert.deepEqual(extractRetireList(text), ["IBE.MC"]);
  });
});

// ── extractPlanSummary ────────────────────────────────────────────────────────

describe("extractPlanSummary", () => {
  it("extracts the plan summary from the AUTOMATED_ACTIONS section", () => {
    const text = `## AUTOMATED_ACTIONS\nRETIRE:\nPLAN_SUMMARY: Acumular cash esta semana`;
    assert.equal(extractPlanSummary(text), "Acumular cash esta semana");
  });

  it("trims spaces", () => {
    const text = `PLAN_SUMMARY:   Comprar XOM por 40 €  `;
    assert.equal(extractPlanSummary(text), "Comprar XOM por 40 €");
  });

  it("returns an empty string if there is no PLAN_SUMMARY", () => {
    assert.equal(extractPlanSummary("## Resumen\n\nSin acciones."), "");
  });
});

// ── applyAddWatchlistEntry ────────────────────────────────────────────────────

const WATCHLIST_MD = `# Watchlist

\`\`\`yaml
watchlist:
  - ticker: DEF.MI
    name: Example Defence
    market: Borsa Italiana
    currency: EUR
    horizon: medium
    thesis: "Defensa europea"
\`\`\`
`;

const newEntry: WatchlistEntry = {
  ticker: "AIR.PA",
  name: "Airbus",
  market: "Euronext Paris",
  currency: "EUR",
  horizon: "medium",
  thesis: "Aeroespacial y defensa",
};

describe("applyAddWatchlistEntry", () => {
  it("adds a new ticker to the YAML block", () => {
    const updated = applyAddWatchlistEntry(WATCHLIST_MD, newEntry);
    assert.ok(updated.includes("AIR.PA"));
  });

  it("keeps the existing ticker", () => {
    const updated = applyAddWatchlistEntry(WATCHLIST_MD, newEntry);
    assert.ok(updated.includes("DEF.MI"));
  });

  it("returns the same string if the ticker already exists (idempotent)", () => {
    const duplicate: WatchlistEntry = { ...newEntry, ticker: "DEF.MI" };
    const updated = applyAddWatchlistEntry(WATCHLIST_MD, duplicate);
    assert.equal(updated, WATCHLIST_MD);
  });

  it("the result is valid Markdown with a yaml block", () => {
    const updated = applyAddWatchlistEntry(WATCHLIST_MD, newEntry);
    assert.ok(updated.includes("```yaml"));
    assert.ok(updated.includes("```"));
  });

  it("keeps asset_class when writing a new entry (round-trip)", () => {
    const commodityEntry: WatchlistEntry = { ...newEntry, ticker: "4GLD.DE", asset_class: "commodity" };
    const updated = applyAddWatchlistEntry(WATCHLIST_MD, commodityEntry);
    assert.ok(/asset_class:\s*commodity/.test(updated));
  });

  it("an entry without asset_class does not write it (stays undefined, not a literal 'equity')", () => {
    const updated = applyAddWatchlistEntry(WATCHLIST_MD, newEntry);
    // The added entry (AIR.PA) does not define asset_class: the default is resolved
    // at the point of use (`entry.asset_class ?? "equity"`), not when writing.
    const parsed = /watchlist:[\s\S]*- ticker: AIR\.PA[\s\S]*?(?=- ticker:|```)/.exec(updated);
    assert.ok(parsed);
    assert.ok(!parsed[0].includes("asset_class"));
  });
});

// ── applyRetireWatchlistEntry ─────────────────────────────────────────────────

describe("applyRetireWatchlistEntry", () => {
  it("removes the ticker from the YAML block", () => {
    const updated = applyRetireWatchlistEntry(WATCHLIST_MD, "DEF.MI");
    assert.ok(!updated.includes("DEF.MI"));
  });

  it("does not change other tickers", () => {
    const md = applyAddWatchlistEntry(WATCHLIST_MD, newEntry);
    const updated = applyRetireWatchlistEntry(md, "DEF.MI");
    assert.ok(updated.includes("AIR.PA"));
  });

  it("does not fail if the ticker does not exist", () => {
    const updated = applyRetireWatchlistEntry(WATCHLIST_MD, "NOEXISTE");
    assert.ok(updated.includes("DEF.MI")); // the rest untouched
  });

  it("the result is still Markdown with a yaml block", () => {
    const updated = applyRetireWatchlistEntry(WATCHLIST_MD, "DEF.MI");
    assert.ok(updated.includes("```yaml"));
  });
});
